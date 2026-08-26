export const PROTOCOL_VERSION = 1;
export const HEADER_SIZE = 32;
export const MAX_DATA_MESSAGE_SIZE = 64 * 1024;
export const MAX_UNACKNOWLEDGED_BYTES = 8 * 1024 * 1024;
export const BUFFERED_AMOUNT_LIMIT = 8 * 1024 * 1024;
export const ACK_INTERVAL_BYTES = 1024 * 1024;
export const FALLBACK_MEMORY_LIMIT = 256 * 1024 * 1024;

const MAGIC = 0x50325046; // P2PF

export type ChunkFrame = {
  fileId: string;
  offset: number;
  payload: ArrayBuffer;
};

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error("无效的文件 ID");
  const bytes = new Uint8Array(16);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function bytesToUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function chooseChunkPayloadSize(maxMessageSize: number | undefined): number {
  const negotiated = maxMessageSize && Number.isFinite(maxMessageSize)
    ? maxMessageSize
    : MAX_DATA_MESSAGE_SIZE;
  const messageSize = Math.min(MAX_DATA_MESSAGE_SIZE, Math.floor(negotiated));
  if (messageSize <= HEADER_SIZE + 1024) throw new Error("浏览器协商的数据消息上限过小");
  return messageSize - HEADER_SIZE;
}

export function encodeChunk(fileId: string, offset: number, payload: ArrayBuffer): ArrayBuffer {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("无效的文件偏移");
  if (payload.byteLength > 0xffff) throw new Error("文件分块超过协议上限");

  const frame = new ArrayBuffer(HEADER_SIZE + payload.byteLength);
  const view = new DataView(frame);
  view.setUint32(0, MAGIC);
  view.setUint8(4, PROTOCOL_VERSION);
  view.setUint8(5, 0);
  view.setUint16(6, payload.byteLength);
  new Uint8Array(frame, 8, 16).set(uuidToBytes(fileId));
  view.setBigUint64(24, BigInt(offset));
  new Uint8Array(frame, HEADER_SIZE).set(new Uint8Array(payload));
  return frame;
}

export function decodeChunk(frame: ArrayBuffer): ChunkFrame {
  if (frame.byteLength < HEADER_SIZE) throw new Error("文件分块头不完整");
  const view = new DataView(frame);
  if (view.getUint32(0) !== MAGIC) throw new Error("未知的文件分块格式");
  if (view.getUint8(4) !== PROTOCOL_VERSION) throw new Error("文件协议版本不兼容");
  const payloadLength = view.getUint16(6);
  if (payloadLength !== frame.byteLength - HEADER_SIZE) throw new Error("文件分块长度不匹配");
  const offset = Number(view.getBigUint64(24));
  if (!Number.isSafeInteger(offset)) throw new Error("文件偏移超出安全范围");
  return {
    fileId: bytesToUuid(new Uint8Array(frame, 8, 16)),
    offset,
    payload: frame.slice(HEADER_SIZE),
  };
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "--";
  if (seconds < 60) return `${Math.ceil(seconds)} 秒`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} 分 ${Math.ceil(seconds % 60)} 秒`;
}

export function suggestedReceivedName(name: string): string {
  return name;
}

export function receivedNameCandidate(name: string, duplicateIndex = 0): string {
  const safeName = name.replace(/[\\/\0]/g, "_") || "未命名文件";
  if (duplicateIndex <= 0) return safeName;
  const extensionAt = safeName.lastIndexOf(".");
  if (extensionAt <= 0 || extensionAt === safeName.length - 1) return `${safeName} (${duplicateIndex})`;
  return `${safeName.slice(0, extensionAt)} (${duplicateIndex})${safeName.slice(extensionAt)}`;
}

export function isNameNotAllowedError(error: unknown): error is TypeError {
  return error instanceof TypeError && /name is not allowed/i.test(error.message);
}

export function describeFileSystemError(error: unknown, fileSize: number): string {
  if (error instanceof DOMException && error.name === "InvalidStateError") {
    return `保存文件失败：目标文件在传输期间发生变化，或磁盘空间不足。请不要覆盖已有文件，换一个新文件名，并确保至少有 ${formatBytes(fileSize)} 可用空间后重试。`;
  }
  if (error instanceof DOMException && error.name === "QuotaExceededError") {
    return `保存文件失败：磁盘空间不足。请至少释放 ${formatBytes(fileSize)} 空间后重试。`;
  }
  if (error instanceof DOMException && error.name === "NotAllowedError") {
    return "保存文件失败：浏览器没有目标文件的写入权限，请重新选择保存位置。";
  }
  if (error instanceof DOMException && error.name === "NoModificationAllowedError") {
    return "保存文件失败：目标文件正在被其他标签页或程序写入。请关闭占用它的程序，并换一个新文件名后重试。";
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return "保存文件被浏览器安全检查中止。请换一个新文件名或保存目录后重试。";
  }
  return error instanceof Error ? error.message : "文件保存失败";
}
