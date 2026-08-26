import { createSHA256 } from "hash-wasm";
import "./style.css";
import {
  ACK_INTERVAL_BYTES,
  BUFFERED_AMOUNT_LIMIT,
  FALLBACK_MEMORY_LIMIT,
  MAX_UNACKNOWLEDGED_BYTES,
  PROTOCOL_VERSION,
  chooseChunkPayloadSize,
  decodeChunk,
  encodeChunk,
  describeFileSystemError,
  formatBytes,
  formatEta,
  isNameNotAllowedError,
  receivedNameCandidate,
  suggestedReceivedName,
} from "./protocol";

type Role = "host" | "guest";
type Hasher = Awaited<ReturnType<typeof createSHA256>>;

type FileMeta = {
  type: "file-meta";
  fileId: string;
  name: string;
  size: number;
  mimeType: string;
  lastModified: number;
  chunkSize: number;
  protocolVersion: number;
};

type ControlMessage =
  | FileMeta
  | { type: "file-accept"; fileId: string; committedOffset: number }
  | { type: "file-reject"; fileId: string; reason?: string }
  | { type: "chunk-ack"; fileId: string; committedOffset: number }
  | { type: "file-complete"; fileId: string; hash: string }
  | { type: "file-verified"; fileId: string; ok: boolean; hash: string }
  | { type: "file-error"; fileId: string; error: string };

type WritableTarget = {
  write(data: ArrayBuffer | Blob): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
};

type PendingReceive = {
  meta: FileMeta;
  writer: WritableTarget | null;
  chunks: ArrayBuffer[];
  hasher: Hasher;
  committedOffset: number;
  lastAckOffset: number;
  senderHash: string | null;
  savedName: string | null;
  requiresSavePicker: boolean;
  storageMode: "directory" | "picker" | "opfs" | "memory";
  opfsKey: string | null;
  opfsHandle: FileTargetHandle | null;
};

type OutgoingStatus = "waiting" | "awaiting" | "sending" | "verifying" | "complete" | "failed";

type OutgoingTask = {
  fileId: string;
  file: File;
  status: OutgoingStatus;
  error?: string;
};

type IncomingStatus = "awaiting" | "receiving" | "verifying" | "complete" | "rejected" | "failed";

type IncomingTask = {
  fileId: string;
  name: string;
  size: number;
  status: IncomingStatus;
  error?: string;
};

type StagedReceive = {
  key: string;
  name: string;
  mimeType: string;
  size: number;
  file: File;
  saving: boolean;
};

type FileTargetHandle = {
  getFile(): Promise<File>;
  createWritable(options?: {
    keepExistingData?: boolean;
    mode?: "exclusive" | "siloed";
  }): Promise<WritableTarget>;
};

type DirectoryTargetHandle = {
  readonly name: string;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileTargetHandle>;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirectoryTargetHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
};

type OpfsStorageManager = StorageManager & {
  getDirectory?: () => Promise<DirectoryTargetHandle>;
};

type SavePickerWindow = Window & {
  showSaveFilePicker?: (options?: { suggestedName?: string }) => Promise<FileTargetHandle>;
  showDirectoryPicker?: (options?: {
    mode?: "read" | "readwrite";
    startIn?: DirectoryTargetHandle;
  }) => Promise<DirectoryTargetHandle>;
};

const element = <T extends HTMLElement>(id: string): T => {
  const value = document.getElementById(id);
  if (!value) throw new Error(`缺少页面元素：${id}`);
  return value as T;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFileMeta(value: unknown): value is FileMeta {
  if (!isRecord(value)) return false;
  return value.type === "file-meta"
    && typeof value.fileId === "string"
    && /^[0-9a-f-]{36}$/i.test(value.fileId)
    && typeof value.name === "string"
    && value.name.length > 0
    && value.name.length <= 512
    && typeof value.size === "number"
    && Number.isSafeInteger(value.size)
    && value.size >= 0
    && typeof value.mimeType === "string"
    && typeof value.lastModified === "number"
    && typeof value.chunkSize === "number"
    && value.protocolVersion === PROTOCOL_VERSION;
}

function parseControl(raw: string): ControlMessage {
  const parsed: unknown = JSON.parse(raw);
  if (isFileMeta(parsed)) return parsed;
  if (!isRecord(parsed) || typeof parsed.type !== "string" || typeof parsed.fileId !== "string") {
    throw new Error("控制消息格式错误");
  }
  const offsetValid = typeof parsed.committedOffset === "number"
    && Number.isSafeInteger(parsed.committedOffset)
    && parsed.committedOffset >= 0;
  switch (parsed.type) {
    case "file-accept":
    case "chunk-ack":
      if (!offsetValid) throw new Error("确认偏移无效");
      return { type: parsed.type, fileId: parsed.fileId, committedOffset: parsed.committedOffset as number };
    case "file-reject":
      return { type: parsed.type, fileId: parsed.fileId, reason: typeof parsed.reason === "string" ? parsed.reason : undefined };
    case "file-complete":
      if (typeof parsed.hash !== "string") throw new Error("文件 Hash 无效");
      return { type: parsed.type, fileId: parsed.fileId, hash: parsed.hash };
    case "file-verified":
      if (typeof parsed.hash !== "string" || typeof parsed.ok !== "boolean") throw new Error("校验消息无效");
      return { type: parsed.type, fileId: parsed.fileId, hash: parsed.hash, ok: parsed.ok };
    case "file-error":
      if (typeof parsed.error !== "string") throw new Error("错误消息无效");
      return { type: parsed.type, fileId: parsed.fileId, error: parsed.error };
    default:
      throw new Error("未知的控制消息");
  }
}

function deviceName(): string {
  const platform = navigator.platform.trim();
  return platform ? `${platform} 浏览器` : "浏览器设备";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

class LanDropApp {
  private role: Role | null = null;
  private roomCode = "";
  private token = "";
  private socket: WebSocket | null = null;
  private peer: RTCPeerConnection | null = null;
  private control: RTCDataChannel | null = null;
  private data: RTCDataChannel | null = null;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private negotiationStarted = false;
  private verified = false;
  private verificationRunning = false;
  private selectedFile: File | null = null;
  private outgoingFileId: string | null = null;
  private outgoingTasks: OutgoingTask[] = [];
  private activeOutgoingTask: OutgoingTask | null = null;
  private incomingTasks: IncomingTask[] = [];
  private senderAckedOffset = 0;
  private receiver: PendingReceive | null = null;
  private receiveDirectory: DirectoryTargetHandle | null = null;
  private opfsDirectory: DirectoryTargetHandle | null = null;
  private opfsAutoAccept = false;
  private stagedReceives: StagedReceive[] = [];
  private readonly ignoredIncomingFileIds = new Set<string>();
  private receiveChain: Promise<void> = Promise.resolve();
  private speedSample = { bytes: 0, time: performance.now(), smoothed: 0 };
  private expiryTimer: number | null = null;

  private readonly home = element<HTMLElement>("home");
  private readonly session = element<HTMLElement>("session");
  private readonly homeError = element<HTMLElement>("homeError");
  private readonly sessionError = element<HTMLElement>("sessionError");
  private readonly codeInput = element<HTMLInputElement>("codeInput");
  private readonly copyCode = element<HTMLButtonElement>("copyCode");
  private readonly expiry = element<HTMLElement>("expiry");
  private readonly connectionStatus = element<HTMLElement>("connectionStatus");
  private readonly peerName = element<HTMLElement>("peerName");
  private readonly statusDot = element<HTMLElement>("statusDot");
  private readonly capabilityWarning = element<HTMLElement>("capabilityWarning");
  private readonly dropZone = element<HTMLLabelElement>("dropZone");
  private readonly fileInput = element<HTMLInputElement>("fileInput");
  private readonly incomingCard = element<HTMLElement>("incomingCard");
  private readonly incomingName = element<HTMLElement>("incomingName");
  private readonly incomingSize = element<HTMLElement>("incomingSize");
  private readonly acceptButton = element<HTMLButtonElement>("acceptButton");
  private readonly openReceiveFolderButton = element<HTMLButtonElement>("openReceiveFolder");
  private readonly mobileSaveCard = element<HTMLElement>("mobileSaveCard");
  private readonly mobileSaveList = element<HTMLUListElement>("mobileSaveList");
  private readonly queueCard = element<HTMLElement>("queueCard");
  private readonly queueSummary = element<HTMLElement>("queueSummary");
  private readonly queueList = element<HTMLOListElement>("queueList");
  private readonly incomingQueueCard = element<HTMLElement>("incomingQueueCard");
  private readonly incomingQueueSummary = element<HTMLElement>("incomingQueueSummary");
  private readonly incomingQueueList = element<HTMLOListElement>("incomingQueueList");
  private readonly transferCard = element<HTMLElement>("transferCard");
  private readonly transferName = element<HTMLElement>("transferName");
  private readonly transferState = element<HTMLElement>("transferState");
  private readonly progressBar = element<HTMLElement>("progressBar");
  private readonly progressText = element<HTMLElement>("progressText");
  private readonly speedText = element<HTMLElement>("speedText");
  private readonly etaText = element<HTMLElement>("etaText");
  private readonly hashState = element<HTMLElement>("hashState");

  constructor() {
    element<HTMLButtonElement>("createButton").addEventListener("click", () => void this.createRoom());
    element<HTMLFormElement>("joinForm").addEventListener("submit", (event) => {
      event.preventDefault();
      void this.joinRoom();
    });
    this.copyCode.addEventListener("click", () => void navigator.clipboard.writeText(this.roomCode));
    this.fileInput.addEventListener("change", () => {
      this.enqueueFiles(Array.from(this.fileInput.files ?? []));
    });
    this.dropZone.addEventListener("click", (event) => {
      if (this.verified) return;
      event.preventDefault();
      this.sessionError.textContent = "请等待 P2P 文件通道连接完成";
    });
    this.dropZone.addEventListener("dragover", (event) => {
      if (!this.verified) return;
      event.preventDefault();
      this.dropZone.classList.add("dragging");
    });
    this.dropZone.addEventListener("dragleave", () => this.dropZone.classList.remove("dragging"));
    this.dropZone.addEventListener("drop", (event) => {
      event.preventDefault();
      this.dropZone.classList.remove("dragging");
      this.enqueueFiles(Array.from(event.dataTransfer?.files ?? []));
    });
    this.acceptButton.addEventListener("click", () => void this.acceptIncoming());
    this.openReceiveFolderButton.addEventListener("click", () => void this.openReceiveFolder());
    element<HTMLButtonElement>("rejectButton").addEventListener("click", () => void this.rejectIncoming());
    window.addEventListener("beforeunload", (event) => {
      if (this.stagedReceives.length === 0) return;
      event.preventDefault();
    });

    const supportsOpfs = typeof (navigator.storage as OpfsStorageManager | undefined)?.getDirectory === "function";
    if (!("showDirectoryPicker" in window) && "showSaveFilePicker" in window) {
      this.capabilityWarning.textContent = "当前浏览器不支持一次授权接收文件夹，批量接收时仍需逐个选择保存位置。建议使用最新版桌面 Chrome 或 Edge。";
      this.capabilityWarning.classList.remove("hidden");
      this.acceptButton.textContent = "选择保存位置并接受";
    } else if (!("showDirectoryPicker" in window) && !("showSaveFilePicker" in window) && supportsOpfs) {
      this.capabilityWarning.textContent = "移动端兼容模式：文件会流式写入浏览器安全存储，接收完成后请点击“保存到设备”。请保持页面打开并预留足够空间。";
      this.capabilityWarning.classList.remove("hidden");
      this.acceptButton.textContent = "接受并流式接收";
    } else if (!("showDirectoryPicker" in window) && !("showSaveFilePicker" in window)) {
      this.capabilityWarning.textContent = `当前浏览器不支持流式磁盘写入，仅允许接收 ${formatBytes(FALLBACK_MEMORY_LIMIT)} 以内的文件。超大文件请使用桌面版 Chrome 或 Edge。`;
      this.capabilityWarning.classList.remove("hidden");
      this.acceptButton.textContent = "接受并下载";
    }
  }

  private async api(path: string): Promise<{ code: string; token: string; expiresAt: number }> {
    const response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceName: deviceName() }),
    });
    const body: unknown = await response.json();
    if (!response.ok || !isRecord(body) || typeof body.code !== "string" || typeof body.token !== "string" || typeof body.expiresAt !== "number") {
      const error = isRecord(body) && typeof body.error === "string" ? body.error : "配对请求失败";
      throw new Error(error);
    }
    return { code: body.code, token: body.token, expiresAt: body.expiresAt };
  }

  private async createRoom(): Promise<void> {
    this.homeError.textContent = "";
    try {
      const result = await this.api("/api/rooms");
      await this.enterSession("host", result);
    } catch (error) {
      this.homeError.textContent = error instanceof Error ? error.message : "创建连接失败";
    }
  }

  private async joinRoom(): Promise<void> {
    const code = this.codeInput.value.trim();
    if (!/^\d{6}$/.test(code)) {
      this.homeError.textContent = "请输入 6 位数字配对码";
      return;
    }
    this.homeError.textContent = "";
    try {
      const result = await this.api(`/api/rooms/${code}/join`);
      await this.enterSession("guest", result);
    } catch (error) {
      this.homeError.textContent = error instanceof Error ? error.message : "加入连接失败";
    }
  }

  private async enterSession(role: Role, result: { code: string; token: string; expiresAt: number }): Promise<void> {
    this.role = role;
    this.roomCode = result.code;
    this.token = result.token;
    this.copyCode.textContent = result.code;
    this.home.classList.add("hidden");
    this.session.classList.remove("hidden");
    this.updateExpiry(result.expiresAt);
    this.createPeer();
    this.connectSignaling();
  }

  private updateExpiry(expiresAt: number): void {
    const render = (): void => {
      const seconds = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
      this.expiry.textContent = seconds > 0 ? `配对码 ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} 后失效` : "配对码已失效";
      if (seconds === 0 && this.expiryTimer !== null) window.clearInterval(this.expiryTimer);
    };
    render();
    this.expiryTimer = window.setInterval(render, 1000);
  }

  private connectSignaling(): void {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    this.socket = new WebSocket(`${protocol}//${location.host}/ws/${this.roomCode}?token=${encodeURIComponent(this.token)}`);
    this.socket.addEventListener("message", (event: MessageEvent<string>) => void this.handleSignal(event.data));
    this.socket.addEventListener("close", () => {
      if (!this.verified) this.setConnection("信令已断开", "请重新创建连接", "error");
    });
  }

  private sendSignal(type: string, payload: unknown): void {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error("信令连接尚未就绪");
    this.socket.send(JSON.stringify({ type, payload }));
  }

  private createPeer(): void {
    this.peer = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }] });
    this.peer.addEventListener("icecandidate", (event) => {
      if (event.candidate) this.sendSignal("ice-candidate", event.candidate.toJSON());
    });
    this.peer.addEventListener("connectionstatechange", () => {
      const state = this.peer?.connectionState;
      if (state === "failed" || state === "closed") this.fail("P2P 连接已断开");
      if (state === "disconnected") this.setConnection("连接暂时中断", "正在等待网络恢复", "error");
      if (state === "connected") void this.verifyDirectConnection();
    });
    this.peer.addEventListener("datachannel", (event) => this.attachChannel(event.channel));

    if (this.role === "host") {
      this.attachChannel(this.peer.createDataChannel("control", { ordered: true }));
      this.attachChannel(this.peer.createDataChannel("file-data", { ordered: true }));
    }
  }

  private attachChannel(channel: RTCDataChannel): void {
    if (channel.label === "control") {
      this.control = channel;
      channel.addEventListener("message", (event: MessageEvent<string>) => void this.handleControl(event.data));
    } else if (channel.label === "file-data") {
      this.data = channel;
      channel.binaryType = "arraybuffer";
      channel.bufferedAmountLowThreshold = BUFFERED_AMOUNT_LIMIT / 2;
      channel.addEventListener("message", (event: MessageEvent<ArrayBuffer>) => {
        this.receiveChain = this.receiveChain
          .then(() => this.handleChunk(event.data))
          .catch((error: unknown) => this.handleLocalReceiveFailure(error));
      });
    } else {
      channel.close();
      return;
    }
    channel.addEventListener("open", () => void this.verifyDirectConnection());
    channel.addEventListener("close", () => {
      if (this.verified) this.fail("文件通道已关闭");
    });
  }

  private async handleSignal(raw: string): Promise<void> {
    try {
      const signal: unknown = JSON.parse(raw);
      if (!isRecord(signal) || typeof signal.type !== "string") return;
      if (signal.type === "waiting") {
        this.setConnection("等待对方设备", "分享上方 6 位配对码", "waiting");
        return;
      }
      if (signal.type === "peer-joined") {
        this.peerName.textContent = typeof signal.deviceName === "string" ? signal.deviceName : "对方设备";
        this.setConnection("正在建立 P2P", this.peerName.textContent, "waiting");
        if (this.role === "host" && !this.negotiationStarted) {
          this.negotiationStarted = true;
          const offer = await this.peer?.createOffer();
          if (!offer || !this.peer) throw new Error("无法创建 WebRTC Offer");
          await this.peer.setLocalDescription(offer);
          this.sendSignal("offer", offer);
        }
        return;
      }
      if (signal.type === "peer-left") {
        if (!this.verified) this.setConnection("对方已离开", "等待重新连接", "error");
        return;
      }
      if (signal.type === "signal-error") {
        this.sessionError.textContent = typeof signal.error === "string" ? signal.error : "信令错误";
        return;
      }
      if (!this.peer || !("payload" in signal)) return;
      if (signal.type === "offer" && this.role === "guest") {
        await this.peer.setRemoteDescription(signal.payload as RTCSessionDescriptionInit);
        await this.flushCandidates();
        const answer = await this.peer.createAnswer();
        await this.peer.setLocalDescription(answer);
        this.sendSignal("answer", answer);
      } else if (signal.type === "answer" && this.role === "host") {
        await this.peer.setRemoteDescription(signal.payload as RTCSessionDescriptionInit);
        await this.flushCandidates();
      } else if (signal.type === "ice-candidate") {
        const candidate = signal.payload as RTCIceCandidateInit;
        if (this.peer.remoteDescription) await this.peer.addIceCandidate(candidate);
        else this.pendingCandidates.push(candidate);
      }
    } catch (error) {
      this.fail(error instanceof Error ? error.message : "WebRTC 信令失败");
    }
  }

  private async flushCandidates(): Promise<void> {
    if (!this.peer) return;
    for (const candidate of this.pendingCandidates) await this.peer.addIceCandidate(candidate);
    this.pendingCandidates = [];
  }

  private async verifyDirectConnection(): Promise<void> {
    if (this.verified || this.verificationRunning || !this.peer || this.peer.connectionState !== "connected") return;
    if (this.control?.readyState !== "open" || this.data?.readyState !== "open") return;
    this.verificationRunning = true;
    try {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const stats = await this.peer.getStats();
        let path: "lan" | "p2p" | "relay" | null = null;
        stats.forEach((report) => {
          let pair: (RTCStats & Record<string, unknown>) | undefined;
          if (report.type === "transport" && typeof report.selectedCandidatePairId === "string") {
            pair = stats.get(report.selectedCandidatePairId) as (RTCStats & Record<string, unknown>) | undefined;
          } else if (report.type === "candidate-pair"
            && report.state === "succeeded"
            && (report.nominated === true || report.selected === true)) {
            pair = report as RTCStats & Record<string, unknown>;
          }
          const localCandidateId = pair?.localCandidateId;
          const remoteCandidateId = pair?.remoteCandidateId;
          if (typeof localCandidateId !== "string" || typeof remoteCandidateId !== "string") return;
          const local = stats.get(localCandidateId);
          const remote = stats.get(remoteCandidateId);
          const localType = local?.candidateType;
          const remoteType = remote?.candidateType;
          if (localType === "relay" || remoteType === "relay") path = "relay";
          else if (path !== "relay" && localType === "host" && remoteType === "host") path = "lan";
          else if (path !== "relay" && typeof localType === "string" && typeof remoteType === "string") path = "p2p";
        });
        if (path === "relay") throw new Error("检测到 TURN 中继，已按隐私策略禁止文件传输");
        if (path === "lan" || path === "p2p") {
          this.setConnection(path === "lan" ? "局域网 P2P 直连" : "公网 P2P 直连", this.peerName.textContent, "online");
          this.enableFileSelection();
          return;
        }
        await delay(200);
      }
      // No TURN server or credentials are configured. Some mobile browsers omit
      // candidate-pair details even when both P2P data channels are already open.
      this.setConnection("P2P 直连", `${this.peerName.textContent} · 浏览器未公开路径类型`, "online");
      this.enableFileSelection();
    } catch (error) {
      this.fail(error instanceof Error ? error.message : "P2P 路径验证失败");
      this.peer.close();
    } finally {
      this.verificationRunning = false;
    }
  }

  private enableFileSelection(): void {
    this.verified = true;
    this.fileInput.disabled = false;
    this.dropZone.classList.remove("disabled");
  }

  private setConnection(title: string, subtitle: string, state: "online" | "waiting" | "error"): void {
    this.connectionStatus.textContent = title;
    this.peerName.textContent = subtitle;
    this.statusDot.className = `status-dot ${state === "waiting" ? "" : state}`;
  }

  private sendControl(control: ControlMessage): void {
    if (this.control?.readyState !== "open") throw new Error("控制通道未连接");
    this.control.send(JSON.stringify(control));
  }

  private enqueueFiles(files: File[]): void {
    this.fileInput.value = "";
    if (files.length === 0 || !this.verified || !this.peer) return;
    if (this.receiver) {
      this.sessionError.textContent = "当前已有文件任务，请等待完成";
      return;
    }
    this.sessionError.textContent = "";
    this.outgoingTasks.push(...files.map((file) => ({
      fileId: crypto.randomUUID(),
      file,
      status: "waiting" as const,
    })));
    this.renderQueue();
    this.startNextOutgoing();
  }

  private startNextOutgoing(): void {
    if (!this.verified || !this.peer || this.activeOutgoingTask || this.receiver) return;
    const task = this.outgoingTasks.find((item) => item.status === "waiting");
    if (!task) return;
    try {
      this.sessionError.textContent = "";
      const chunkSize = chooseChunkPayloadSize(this.peer.sctp?.maxMessageSize);
      this.activeOutgoingTask = task;
      this.selectedFile = task.file;
      this.outgoingFileId = task.fileId;
      this.senderAckedOffset = 0;
      task.status = "awaiting";
      this.renderQueue();
      this.showTransfer(task.file.name, task.file.size, "等待对方接受");
      this.sendControl({
        type: "file-meta",
        fileId: task.fileId,
        name: task.file.name,
        size: task.file.size,
        mimeType: task.file.type || "application/octet-stream",
        lastModified: task.file.lastModified,
        chunkSize,
        protocolVersion: PROTOCOL_VERSION,
      });
    } catch (error) {
      const text = error instanceof Error ? error.message : "无法发送文件请求";
      this.fail(text);
      this.finishActiveOutgoing("failed", text, false);
    }
  }

  private async handleControl(raw: string): Promise<void> {
    try {
      const control = parseControl(raw);
      switch (control.type) {
        case "file-meta":
          await this.prepareIncoming(control);
          break;
        case "file-accept":
          if (control.fileId === this.outgoingFileId) {
            this.senderAckedOffset = control.committedOffset;
            this.setActiveOutgoingStatus("sending");
            void this.sendFile(control.committedOffset);
          }
          break;
        case "chunk-ack":
          if (control.fileId === this.outgoingFileId) this.senderAckedOffset = Math.max(this.senderAckedOffset, control.committedOffset);
          break;
        case "file-reject":
          if (control.fileId === this.outgoingFileId) {
            const reason = control.reason ?? "对方拒绝了文件";
            this.fail(reason);
            this.finishActiveOutgoing("failed", reason, false);
          }
          break;
        case "file-complete":
          await this.finishIncoming(control.fileId, control.hash);
          break;
        case "file-verified":
          if (control.fileId === this.outgoingFileId) {
            this.hashState.textContent = control.ok ? `SHA-256：校验通过 · ${control.hash}` : "SHA-256：接收端校验失败";
            this.transferState.textContent = control.ok ? "传输完成" : "校验失败";
            if (control.ok) this.transferCard.classList.add("hidden");
            this.finishActiveOutgoing(control.ok ? "complete" : "failed", control.ok ? undefined : "SHA-256 校验失败", false);
          }
          break;
        case "file-error":
          await this.handlePeerFileError(control.fileId, control.error);
          break;
      }
    } catch (error) {
      this.fail(error instanceof Error ? error.message : "控制协议错误");
    }
  }

  private async prepareIncoming(meta: FileMeta): Promise<void> {
    const incomingTask: IncomingTask = {
      fileId: meta.fileId,
      name: meta.name,
      size: meta.size,
      status: "awaiting",
    };
    this.incomingTasks.push(incomingTask);
    this.renderIncomingQueue();
    if (this.receiver || this.selectedFile) {
      this.setIncomingStatus(meta.fileId, "rejected", "当前设备正在处理其他文件");
      this.sendControl({ type: "file-reject", fileId: meta.fileId, reason: "当前设备正在处理其他文件" });
      return;
    }
    const hasher = await createSHA256();
    hasher.init();
    const receiver: PendingReceive = {
      meta,
      writer: null,
      chunks: [],
      hasher,
      committedOffset: 0,
      lastAckOffset: 0,
      senderHash: null,
      savedName: null,
      requiresSavePicker: false,
      storageMode: "memory",
      opfsKey: null,
      opfsHandle: null,
    };
    this.receiver = receiver;
    this.incomingName.textContent = meta.name;
    this.incomingSize.textContent = `${formatBytes(meta.size)} · ${meta.mimeType}`;
    if (!this.receiveDirectory && !this.opfsAutoAccept) {
      this.incomingCard.classList.remove("hidden");
      return;
    }
    try {
      await this.prepareReceiverTarget(receiver);
      if (receiver.storageMode === "opfs") this.opfsAutoAccept = true;
      this.beginReceiving(receiver);
    } catch (error) {
      if (isNameNotAllowedError(error)) {
        // Chromium blocks security-sensitive extensions when they are created
        // through a directory handle. The save picker can display Chrome's
        // dangerous-file confirmation, so route only this file through it.
        receiver.requiresSavePicker = true;
        this.incomingCard.classList.remove("hidden");
        this.acceptButton.textContent = "选择保存位置并接受";
        this.sessionError.textContent = "浏览器不允许自动创建此类型文件，请为它单独选择保存位置。";
        return;
      }
      if (this.receiveDirectory) {
        this.receiveDirectory = null;
        this.renderReceiveFolderButton();
        this.acceptButton.textContent = "选择接收文件夹并接受";
      }
      this.incomingCard.classList.remove("hidden");
      const nextStep = this.opfsAutoAccept ? "请释放设备空间后重试，或拒绝此文件。" : "请重新选择保存位置。";
      this.sessionError.textContent = `${describeFileSystemError(error, meta.size)} ${nextStep}`;
    }
  }

  private async acceptIncoming(): Promise<void> {
    const receiver = this.receiver;
    if (!receiver) return;
    try {
      const directoryPicker = (window as SavePickerWindow).showDirectoryPicker;
      if (!receiver.requiresSavePicker && directoryPicker && !this.receiveDirectory) {
        this.receiveDirectory = await directoryPicker({ mode: "readwrite" });
        this.renderReceiveFolderButton();
        this.acceptButton.textContent = "确认接收";
      }
      await this.prepareReceiverTarget(receiver);
      if (receiver.storageMode === "opfs") this.opfsAutoAccept = true;
      this.beginReceiving(receiver);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (isNameNotAllowedError(error)) {
        receiver.requiresSavePicker = true;
        this.incomingCard.classList.remove("hidden");
        this.acceptButton.textContent = "选择保存位置并接受";
        this.sessionError.textContent = "浏览器不允许通过接收文件夹创建此类型文件，请为它单独选择保存位置。";
        return;
      }
      if (error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError")) {
        this.receiveDirectory = null;
        this.renderReceiveFolderButton();
        this.acceptButton.textContent = "选择接收文件夹并接受";
      }
      this.sessionError.textContent = describeFileSystemError(error, receiver.meta.size);
    }
  }

  private async prepareReceiverTarget(receiver: PendingReceive): Promise<void> {
    if (receiver.requiresSavePicker) {
      const picker = (window as SavePickerWindow).showSaveFilePicker;
      if (!picker) throw new Error("当前浏览器不支持为受限类型单独选择保存位置");
      const handle = await picker({ suggestedName: suggestedReceivedName(receiver.meta.name) });
      receiver.savedName = receiver.meta.name;
      receiver.writer = await this.createWritable(handle);
      receiver.storageMode = "picker";
      return;
    }
    if (this.receiveDirectory) {
      receiver.savedName = await this.findAvailableReceivedName(this.receiveDirectory, receiver.meta.name);
      const handle = await this.receiveDirectory.getFileHandle(receiver.savedName, { create: true });
      receiver.writer = await this.createWritable(handle);
      receiver.storageMode = "directory";
      return;
    }
    const picker = (window as SavePickerWindow).showSaveFilePicker;
    if (picker) {
      const handle = await picker({ suggestedName: suggestedReceivedName(receiver.meta.name) });
      receiver.savedName = receiver.meta.name;
      receiver.writer = await this.createWritable(handle);
      receiver.storageMode = "picker";
      return;
    }
    const storage = navigator.storage as OpfsStorageManager | undefined;
    if (storage?.getDirectory) {
      const estimate = await storage.estimate();
      if (typeof estimate.quota === "number" && typeof estimate.usage === "number"
        && receiver.meta.size > Math.max(0, estimate.quota - estimate.usage)) {
        throw new DOMException("浏览器存储空间不足", "QuotaExceededError");
      }
      try {
        await storage.persist();
      } catch {
        // Persistence is optional while the page remains open.
      }
      if (!this.opfsDirectory) {
        const root = await storage.getDirectory();
        this.opfsDirectory = await root.getDirectoryHandle("lan-drop-received", { create: true });
      }
      receiver.opfsKey = receiver.meta.fileId;
      receiver.opfsHandle = await this.opfsDirectory.getFileHandle(receiver.opfsKey, { create: true });
      receiver.writer = await this.createWritable(receiver.opfsHandle);
      receiver.savedName = receiver.meta.name;
      receiver.storageMode = "opfs";
      return;
    }
    if (receiver.meta.size > FALLBACK_MEMORY_LIMIT) {
      throw new Error(`当前浏览器不能安全接收超过 ${formatBytes(FALLBACK_MEMORY_LIMIT)} 的文件`);
    }
    receiver.savedName = receiver.meta.name;
  }

  private async createWritable(handle: FileTargetHandle): Promise<WritableTarget> {
    try {
      return await handle.createWritable({ keepExistingData: false, mode: "exclusive" });
    } catch (error) {
      // Older Chromium releases implemented createWritable() before locking mode.
      if (!(error instanceof TypeError)) throw error;
      return handle.createWritable({ keepExistingData: false });
    }
  }

  private async findAvailableReceivedName(directory: DirectoryTargetHandle, originalName: string): Promise<string> {
    for (let duplicateIndex = 0; duplicateIndex < 10_000; duplicateIndex += 1) {
      const candidate = receivedNameCandidate(originalName, duplicateIndex);
      try {
        await directory.getFileHandle(candidate);
      } catch (error) {
        if (error instanceof DOMException && error.name === "NotFoundError") return candidate;
        if (error instanceof DOMException && error.name === "TypeMismatchError") continue;
        throw error;
      }
    }
    throw new Error("接收文件夹中同名文件过多，请更换接收文件夹");
  }

  private beginReceiving(receiver: PendingReceive): void {
    this.sessionError.textContent = "";
    this.incomingCard.classList.add("hidden");
    const displayName = receiver.savedName && receiver.savedName !== receiver.meta.name
      ? `${receiver.meta.name} → ${receiver.savedName}`
      : receiver.meta.name;
    this.showTransfer(displayName, receiver.meta.size, "正在接收");
    this.setIncomingStatus(receiver.meta.fileId, "receiving");
    this.sendControl({ type: "file-accept", fileId: receiver.meta.fileId, committedOffset: 0 });
  }

  private async rejectIncoming(): Promise<void> {
    if (!this.receiver) return;
    const receiver = this.receiver;
    this.setIncomingStatus(receiver.meta.fileId, "rejected", "接收方已拒绝");
    this.sendControl({ type: "file-reject", fileId: receiver.meta.fileId, reason: "接收方已拒绝" });
    await this.abortReceiver(receiver, "接收方已拒绝");
    this.receiver = null;
    this.incomingCard.classList.add("hidden");
  }

  private async handleChunk(raw: ArrayBuffer): Promise<void> {
    const frame = decodeChunk(raw);
    if (this.ignoredIncomingFileIds.has(frame.fileId)) return;
    const receiver = this.receiver;
    if (!receiver || (!receiver.writer && receiver.meta.size > FALLBACK_MEMORY_LIMIT)) throw new Error("尚未准备好接收文件");
    if (frame.fileId !== receiver.meta.fileId) throw new Error("文件 ID 不匹配");
    if (frame.offset !== receiver.committedOffset) throw new Error(`文件偏移不连续：期待 ${receiver.committedOffset}，收到 ${frame.offset}`);
    if (receiver.committedOffset + frame.payload.byteLength > receiver.meta.size) throw new Error("收到的数据超过文件大小");

    if (receiver.writer) await receiver.writer.write(frame.payload);
    else receiver.chunks.push(frame.payload);
    receiver.hasher.update(new Uint8Array(frame.payload));
    receiver.committedOffset += frame.payload.byteLength;
    this.updateProgress(receiver.committedOffset, receiver.meta.size);

    if (receiver.committedOffset - receiver.lastAckOffset >= ACK_INTERVAL_BYTES || receiver.committedOffset === receiver.meta.size) {
      receiver.lastAckOffset = receiver.committedOffset;
      this.sendControl({ type: "chunk-ack", fileId: receiver.meta.fileId, committedOffset: receiver.committedOffset });
    }
  }

  private async waitForSendCapacity(nextOffset: number, fileId: string): Promise<void> {
    while (true) {
      if (this.outgoingFileId !== fileId) throw new Error("文件任务已取消");
      if (this.data?.readyState !== "open") throw new Error("文件通道已断开");
      const networkReady = this.data.bufferedAmount < BUFFERED_AMOUNT_LIMIT;
      const diskReady = nextOffset - this.senderAckedOffset < MAX_UNACKNOWLEDGED_BYTES;
      if (networkReady && diskReady) return;
      await delay(12);
    }
  }

  private async sendFile(startOffset: number): Promise<void> {
    const file = this.selectedFile;
    const fileId = this.outgoingFileId;
    if (!file || !fileId || !this.peer || !this.data) return;
    try {
      const chunkSize = chooseChunkPayloadSize(this.peer.sctp?.maxMessageSize);
      const hasher = await createSHA256();
      hasher.init();
      let offset = 0;

      // The current MVP only resumes within an active page session. Re-hash the prefix
      // so the final digest still covers the complete file.
      while (offset < startOffset) {
        const end = Math.min(offset + chunkSize, startOffset);
        hasher.update(new Uint8Array(await file.slice(offset, end).arrayBuffer()));
        offset = end;
      }

      this.transferState.textContent = "正在发送";
      while (offset < file.size) {
        await this.waitForSendCapacity(offset, fileId);
        const end = Math.min(offset + chunkSize, file.size);
        const payload = await file.slice(offset, end).arrayBuffer();
        hasher.update(new Uint8Array(payload));
        this.data.send(encodeChunk(fileId, offset, payload));
        offset = end;
        this.updateProgress(offset, file.size);
      }

      while (this.senderAckedOffset < file.size) {
        if (this.outgoingFileId !== fileId) throw new Error("文件任务已取消");
        if (this.data.readyState !== "open") throw new Error("文件通道已断开");
        await delay(12);
      }
      if (this.outgoingFileId !== fileId) throw new Error("文件任务已取消");
      const hash = hasher.digest("hex");
      this.hashState.textContent = `SHA-256：发送端 ${hash}`;
      this.transferState.textContent = "等待接收端校验";
      this.setActiveOutgoingStatus("verifying");
      this.sendControl({ type: "file-complete", fileId, hash });
    } catch (error) {
      if (this.outgoingFileId !== fileId) return;
      const text = error instanceof Error ? error.message : "文件发送失败";
      this.fail(text);
      this.trySendControl({ type: "file-error", fileId, error: text });
      this.finishActiveOutgoing("failed", text, true);
    }
  }

  private async finishIncoming(fileId: string, senderHash: string): Promise<void> {
    const receiver = this.receiver;
    if (!receiver || receiver.meta.fileId !== fileId) throw new Error("完成消息对应未知文件");
    if (receiver.committedOffset !== receiver.meta.size) {
      this.setIncomingStatus(fileId, "failed", "文件尚未完整写入");
      throw new Error("文件尚未完整写入");
    }
    try {
      this.setIncomingStatus(fileId, "verifying");
      receiver.senderHash = senderHash;
      const localHash = receiver.hasher.digest("hex");
      const ok = localHash === senderHash;
      if (receiver.writer) await receiver.writer.close();
      else {
        const url = URL.createObjectURL(new Blob(receiver.chunks, { type: receiver.meta.mimeType }));
        const link = document.createElement("a");
        link.href = url;
        link.download = suggestedReceivedName(receiver.meta.name);
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
      if (receiver.storageMode === "opfs") {
        if (ok && receiver.opfsHandle && receiver.opfsKey) {
          const storedFile = await receiver.opfsHandle.getFile();
          this.stagedReceives.push({
            key: receiver.opfsKey,
            name: receiver.meta.name,
            mimeType: receiver.meta.mimeType,
            size: receiver.meta.size,
            file: storedFile,
            saving: false,
          });
          this.renderStagedReceives();
        } else if (receiver.opfsKey) {
          await this.removeOpfsEntry(receiver.opfsKey);
        }
      }
      this.hashState.textContent = ok ? `SHA-256：校验通过 · ${localHash}` : `SHA-256：校验失败 · ${localHash}`;
      this.transferState.textContent = ok ? "接收完成" : "校验失败";
      this.setIncomingStatus(fileId, ok ? "complete" : "failed", ok ? undefined : "SHA-256 校验失败");
      this.sendControl({ type: "file-verified", fileId, ok, hash: localHash });
      if (ok) this.transferCard.classList.add("hidden");
      this.receiver = null;
    } catch (error) {
      const text = describeFileSystemError(error, receiver.meta.size);
      await this.abortReceiver(receiver, text);
      this.receiver = null;
      this.transferState.textContent = "保存失败";
      this.hashState.textContent = "SHA-256：文件未能提交到磁盘";
      this.setIncomingStatus(fileId, "failed", text);
      this.trySendControl({ type: "file-error", fileId, error: text });
      throw new Error(text);
    }
  }

  private renderStagedReceives(): void {
    this.mobileSaveCard.classList.toggle("hidden", this.stagedReceives.length === 0);
    this.mobileSaveList.replaceChildren(...this.stagedReceives.map((staged) => {
      const item = document.createElement("li");
      const details = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = staged.name;
      const size = document.createElement("span");
      size.textContent = formatBytes(staged.size);
      details.appendChild(name);
      details.appendChild(size);
      const save = document.createElement("button");
      save.className = "ghost compact";
      save.textContent = staged.saving ? "正在保存…" : "保存到设备";
      save.disabled = staged.saving;
      save.addEventListener("click", () => void this.exportStagedReceive(staged));
      item.appendChild(details);
      item.appendChild(save);
      return item;
    }));
  }

  private async exportStagedReceive(staged: StagedReceive): Promise<void> {
    staged.saving = true;
    this.renderStagedReceives();
    try {
      const output = new File([staged.file], staged.name, { type: staged.mimeType, lastModified: Date.now() });
      const shareData: ShareData = { files: [output], title: staged.name };
      if (typeof navigator.share === "function" && navigator.canShare?.(shareData)) {
        await navigator.share(shareData);
        await this.removeCompletedStagedReceive(staged);
        return;
      }
      const url = URL.createObjectURL(output);
      const link = document.createElement("a");
      link.href = url;
      link.download = staged.name;
      link.click();
      window.setTimeout(() => {
        URL.revokeObjectURL(url);
        void this.removeCompletedStagedReceive(staged);
      }, 60_000);
    } catch (error) {
      staged.saving = false;
      this.renderStagedReceives();
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        this.sessionError.textContent = error instanceof Error ? error.message : "无法保存到设备";
      }
    }
  }

  private async removeCompletedStagedReceive(staged: StagedReceive): Promise<void> {
    await this.removeOpfsEntry(staged.key);
    this.stagedReceives = this.stagedReceives.filter((item) => item !== staged);
    this.renderStagedReceives();
  }

  private async removeOpfsEntry(key: string): Promise<void> {
    try {
      await this.opfsDirectory?.removeEntry(key);
    } catch {
      // The browser may already have evicted or removed the temporary entry.
    }
  }

  private trySendControl(control: ControlMessage): void {
    try {
      this.sendControl(control);
    } catch {
      // The local UI still needs to recover even if the peer disconnected.
    }
  }

  private async abortReceiver(receiver: PendingReceive, reason: string): Promise<void> {
    if (receiver.writer) {
      try {
        await receiver.writer.abort(reason);
      } catch {
        // A stream whose close already failed may no longer be abortable.
      }
    }
    if (receiver.opfsKey) await this.removeOpfsEntry(receiver.opfsKey);
  }

  private async handleLocalReceiveFailure(error: unknown): Promise<void> {
    const receiver = this.receiver;
    const text = describeFileSystemError(error, receiver?.meta.size ?? 0);
    if (receiver) {
      this.setIncomingStatus(receiver.meta.fileId, "failed", text);
      this.ignoredIncomingFileIds.add(receiver.meta.fileId);
      await this.abortReceiver(receiver, text);
      this.trySendControl({ type: "file-error", fileId: receiver.meta.fileId, error: text });
      this.receiver = null;
    }
    this.transferState.textContent = "保存失败";
    this.hashState.textContent = "SHA-256：文件未能提交到磁盘";
    this.fail(text);
  }

  private async handlePeerFileError(fileId: string, reason: string): Promise<void> {
    this.fail(reason);
    if (this.outgoingFileId === fileId) {
      this.transferState.textContent = "对方保存失败";
      this.hashState.textContent = "SHA-256：未完成接收端校验";
      this.finishActiveOutgoing("failed", reason, true);
    }
    if (this.receiver?.meta.fileId === fileId) {
      this.setIncomingStatus(fileId, "failed", reason);
      this.ignoredIncomingFileIds.add(fileId);
      await this.abortReceiver(this.receiver, reason);
      this.receiver = null;
      this.transferState.textContent = "传输失败";
    }
  }

  private showTransfer(name: string, size: number, state: string): void {
    this.transferCard.classList.remove("hidden");
    this.transferName.textContent = name;
    this.transferState.textContent = state;
    this.hashState.textContent = "SHA-256：传输中增量计算";
    this.speedSample = { bytes: 0, time: performance.now(), smoothed: 0 };
    this.updateProgress(0, size);
  }

  private updateProgress(bytes: number, total: number): void {
    const percent = total === 0 ? 100 : Math.min(100, bytes / total * 100);
    this.progressBar.style.width = `${percent}%`;
    this.progressText.textContent = `${formatBytes(bytes)} / ${formatBytes(total)} · ${percent.toFixed(1)}%`;
    const now = performance.now();
    const elapsed = (now - this.speedSample.time) / 1000;
    if (elapsed >= 0.5) {
      const instant = (bytes - this.speedSample.bytes) / elapsed;
      this.speedSample.smoothed = this.speedSample.smoothed === 0 ? instant : this.speedSample.smoothed * 0.7 + instant * 0.3;
      this.speedSample = { bytes, time: now, smoothed: this.speedSample.smoothed };
      this.speedText.textContent = `${formatBytes(this.speedSample.smoothed)}/s`;
      this.etaText.textContent = `剩余 ${formatEta((total - bytes) / this.speedSample.smoothed)}`;
    }
  }

  private setActiveOutgoingStatus(status: OutgoingStatus, error?: string): void {
    if (!this.activeOutgoingTask) return;
    this.activeOutgoingTask.status = status;
    this.activeOutgoingTask.error = error;
    this.renderQueue();
  }

  private finishActiveOutgoing(status: "complete" | "failed", error: string | undefined, waitForDrain: boolean): void {
    this.setActiveOutgoingStatus(status, error);
    this.resetOutgoing();
    if (waitForDrain) void this.startNextOutgoingAfterDrain();
    else this.startNextOutgoing();
  }

  private async startNextOutgoingAfterDrain(): Promise<void> {
    while (this.data?.readyState === "open" && this.data.bufferedAmount > 0) await delay(20);
    this.startNextOutgoing();
  }

  private setIncomingStatus(fileId: string, status: IncomingStatus, error?: string): void {
    const task = this.incomingTasks.find((item) => item.fileId === fileId);
    if (!task) return;
    task.status = status;
    task.error = error;
    this.renderIncomingQueue();
  }

  private renderIncomingQueue(): void {
    const statusLabels: Record<IncomingStatus, string> = {
      awaiting: "等待确认",
      receiving: "接收中",
      verifying: "校验中",
      complete: "完成",
      rejected: "已拒绝",
      failed: "失败",
    };
    this.incomingQueueCard.classList.toggle("hidden", this.incomingTasks.length === 0);
    const completed = this.incomingTasks.filter((task) => task.status === "complete").length;
    const failed = this.incomingTasks.filter((task) => task.status === "failed").length;
    const rejected = this.incomingTasks.filter((task) => task.status === "rejected").length;
    this.incomingQueueSummary.textContent = `共 ${this.incomingTasks.length} 个 · 完成 ${completed}${failed ? ` · 失败 ${failed}` : ""}${rejected ? ` · 拒绝 ${rejected}` : ""}`;
    this.incomingQueueList.replaceChildren(...this.incomingTasks.map((task) => {
      const item = document.createElement("li");
      item.className = `queue-item queue-${task.status}`;
      const details = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = task.name;
      const size = document.createElement("span");
      size.textContent = formatBytes(task.size);
      details.appendChild(name);
      details.appendChild(size);
      const status = document.createElement("span");
      status.className = "queue-status";
      status.textContent = statusLabels[task.status];
      if (task.error) status.title = task.error;
      item.appendChild(details);
      item.appendChild(status);
      return item;
    }));
  }

  private renderReceiveFolderButton(): void {
    const directory = this.receiveDirectory;
    this.openReceiveFolderButton.classList.toggle("hidden", !directory);
    const label = directory ? `打开接收文件夹：${directory.name}` : "打开接收文件夹";
    this.openReceiveFolderButton.title = label;
    this.openReceiveFolderButton.setAttribute("aria-label", label);
  }

  private async openReceiveFolder(): Promise<void> {
    const directory = this.receiveDirectory;
    const picker = (window as SavePickerWindow).showDirectoryPicker;
    if (!directory || !picker) return;
    try {
      await picker({ mode: "read", startIn: directory });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      this.sessionError.textContent = "无法打开接收文件夹";
    }
  }

  private renderQueue(): void {
    const statusLabels: Record<OutgoingStatus, string> = {
      waiting: "等待",
      awaiting: "等待接受",
      sending: "发送中",
      verifying: "校验中",
      complete: "完成",
      failed: "失败",
    };
    this.queueCard.classList.toggle("hidden", this.outgoingTasks.length === 0);
    const completed = this.outgoingTasks.filter((task) => task.status === "complete").length;
    const failed = this.outgoingTasks.filter((task) => task.status === "failed").length;
    this.queueSummary.textContent = `共 ${this.outgoingTasks.length} 个 · 完成 ${completed}${failed ? ` · 失败 ${failed}` : ""}`;
    this.queueList.replaceChildren(...this.outgoingTasks.map((task) => {
      const item = document.createElement("li");
      item.className = `queue-item queue-${task.status}`;
      const details = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = task.file.name;
      const size = document.createElement("span");
      size.textContent = formatBytes(task.file.size);
      details.appendChild(name);
      details.appendChild(size);
      const status = document.createElement("span");
      status.className = "queue-status";
      status.textContent = statusLabels[task.status];
      if (task.error) status.title = task.error;
      item.appendChild(details);
      item.appendChild(status);
      return item;
    }));
  }

  private resetOutgoing(): void {
    this.selectedFile = null;
    this.outgoingFileId = null;
    this.activeOutgoingTask = null;
    this.senderAckedOffset = 0;
  }

  private fail(reason: string): void {
    this.sessionError.textContent = reason;
    if (this.transferState.textContent.includes("正在")) this.transferState.textContent = "已停止";
  }
}

new LanDropApp();
