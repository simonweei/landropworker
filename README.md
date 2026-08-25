# Cloudflare Worker + WebRTC 局域网 P2P 文件互传

> 实施状态：MVP 已按下述“实施版修订”开发。后文保留产品目标和阶段规划；若与实施版修订冲突，以实施版修订为准。

## 实施版修订（2026-08-26）

本版继续使用 **6 位数字配对码**。用户只需要输入这 6 位数字；浏览器与服务端内部会自动使用不可见的随机会话令牌保护 WebSocket 连接。

### 首版支持范围

```text
桌面 Chrome / Edge：
- File System Access API 流式写盘
- 面向 GB / 数十 GB / 100GB 级文件的恒定内存架构
- 实际最大文件能力仍以浏览器、磁盘空间和真实设备压力测试为准

不支持 showSaveFilePicker() 的浏览器：
- 只允许接收不超过 256MB 的内存降级文件
- 超过限制时明确拒绝，不把大文件偷偷堆入内存
```

Safari/iOS 可以参与配对和 WebRTC，但本版不承诺超大文件流式落盘。所有能力均使用 feature detection，不使用 User-Agent 猜测。

### 已修订的传输可靠性规则

1. 文件数据和控制消息使用两个独立、可靠、有序的 DataChannel。
2. 二进制帧采用 32 字节 Header，包含协议版本、File ID、64 位 Offset 和 Payload Length。
3. Chunk 不再固定为 64KB。连接后读取 `RTCSctpTransport.maxMessageSize`，确保 `Header + Payload` 不超过协商上限，且单条消息最大 64KB。
4. 发送端同时受两层背压约束：浏览器 `bufferedAmount` 和接收端已成功写盘的 `committedOffset`。
5. 接收端只有在 `WritableStream.write()` 成功后才发送 ACK；发送端最多允许 8MB 未确认数据，避免磁盘较慢时接收端内存持续增长。
6. SHA-256 使用增量 WASM 实现，在传输过程中同步计算，不调用需要完整输入的 `crypto.subtle.digest()`。
7. 只有通过标准 `transport.selectedCandidatePairId` 找到当前候选对并确认没有 `relay` 后，才开放文件选择。
8. `host + host` 显示为局域网 P2P；其他非 relay 候选显示为公网 P2P；任何 relay 路径都会立即禁止传输。
9. 当前断点能力限定为协议和同页面会话内的 committed offset；跨刷新、跨浏览器重启的完整断点续传仍属于第二阶段。

### Cloudflare 实施约束

- Durable Object 使用 WebSocket Hibernation API，连接角色通过 WebSocket attachment 恢复。
- 房间过期使用 Durable Object alarm，不依赖内存计时器。
- Worker 只接受有大小限制的 JSON 信令；项目不存在上传、下载或文件代理路由。
- 静态资源与 API 使用同源策略、Origin 校验、CSP 和其他安全响应头。
- STUN 仅使用 `stun:stun.cloudflare.com:3478`，不配置任何 TURN URL 或凭据。

### 大文件保存注意事项

File System Access API 通常先写入浏览器管理的临时文件，并在 `close()` 时提交到最终文件。因此进度到达 100% 代表数据已经接收并写入临时流，不代表最终文件已经成功提交到磁盘。

- 接收端默认建议使用 `LAN-Drop-原文件名`，降低误覆盖已有文件的风险。
- 支持时使用 `createWritable({ mode: "exclusive" })` 获取独占写入锁，避免多个标签页同时提交同一个目标文件。
- 不要在传输期间打开、移动、替换或修改目标文件。
- 保存新文件时至少预留与文件大小相当的空间；覆盖已有大文件时可能需要同时容纳旧文件和临时文件。
- 写盘或收尾失败时，接收端会向发送端发送 `file-error`，双方都会释放当前任务，可以直接重新选择文件重试。
- `InvalidStateError` 会转换成中文提示，不再让发送端永久停留在“等待接收端校验”。

## 1. 项目目标

开发一个基于浏览器的局域网 P2P 文件传输工具。

核心目标：

- 客户端无需下载安装任何软件
- 两台设备只需要打开同一个网页
- 通过配对码进行设备匹配
- Cloudflare Worker / Durable Objects 只负责网页、配对和 WebRTC 信令
- 文件本体不得上传 Cloudflare
- 文件本体不得保存到服务器
- 文件本体不得经过 Worker 转发
- 两台设备建立 WebRTC DataChannel 后直接 P2P 传输
- 同一局域网设备应优先通过局域网 IP 直接通信
- 支持 GB / 数十 GB / 100GB 级大文件
- 支持高速传输，尽可能利用局域网带宽
- 支持多文件传输
- 支持文件夹传输
- 支持传输进度和实时速度显示
- 支持 SHA-256 完整性校验
- 架构上预留断点续传能力
- 不使用 TURN 中继文件数据
- 如果无法建立真正 P2P 连接，应提示用户，而不是通过服务器中继文件

---

# 2. 核心原则

必须保证：

```text
Cloudflare 只负责：
- 托管网页
- 创建配对房间
- WebSocket 信令
- WebRTC Offer
- WebRTC Answer
- ICE Candidate

Cloudflare 不负责：
- 文件上传
- 文件下载
- 文件缓存
- 文件转发
- 文件存储
```

真正的文件传输路径：

```text
设备 A Browser
      │
      │ WebRTC DataChannel
      │
      ▼
设备 B Browser
```

而不是：

```text
设备 A
  ↓
Cloudflare
  ↓
设备 B
```

---

# 3. 整体架构

```text
                  Cloudflare
              ┌─────────────────┐
              │     Worker      │
              │                 │
              │   Web / API     │
              └────────┬────────┘
                       │
                       │ WebSocket
                       │
              ┌────────▼────────┐
              │ Durable Object  │
              │                 │
              │ Pairing Room    │
              │ Signaling       │
              └───────┬─────────┘
                      │
                Signaling Only
              ┌───────┴────────┐
              │                │
              ▼                ▼
        ┌──────────┐      ┌──────────┐
        │ Device A │      │ Device B │
        │ Browser  │      │ Browser  │
        └────┬─────┘      └────▲─────┘
             │                  │
             │ WebRTC           │
             │ DataChannel      │
             └══════════════════┘

                 File Data
                 P2P Direct
```

---

# 4. Cloudflare 技术栈

使用：

```text
Cloudflare Workers
Cloudflare Durable Objects
WebSocket
TypeScript
```

前端：

```text
HTML
CSS
TypeScript / JavaScript
WebRTC
RTCDataChannel
File API
Web Crypto API
```

第一版不需要：

```text
R2
D1
KV
数据库
文件存储
```

除非以后需要保存用户设置或其他非文件数据。

---

# 5. 用户使用流程

## 5.1 打开网页

例如：

```text
https://send.example.com
```

设备 A 和设备 B 分别打开网页。

---

# 6. 创建配对

设备 A 点击：

```text
创建连接
```

服务器随机生成 6 位配对码：

```text
827361
```

页面显示：

```text
我的设备

DESKTOP-A

配对码：

827361

等待其他设备连接……
```

配对码要求：

- 随机生成
- 6 位数字
- 短时间有效
- 建议 5 分钟过期
- 两台设备成功连接后立即失效
- 防止第三台设备加入已经完成配对的房间

---

# 7. 加入配对

设备 B 输入：

```text
827361
```

点击：

```text
连接设备
```

然后通过 Durable Object 找到对应房间。

---

# 8. WebSocket 信令

设备 A 和设备 B 都与对应 Durable Object 建立 WebSocket。

Durable Object 只负责转发：

```text
offer
answer
ice-candidate
peer-joined
peer-left
```

例如消息格式：

```json
{
  "type": "offer",
  "payload": {}
}
```

ICE：

```json
{
  "type": "ice-candidate",
  "payload": {}
}
```

服务器不得接触文件数据。

---

# 9. WebRTC 建立连接

设备 A 创建：

```javascript
RTCPeerConnection
```

并创建：

```javascript
RTCDataChannel
```

例如：

```javascript
peerConnection.createDataChannel("file-transfer")
```

设备 A 创建：

```text
Offer
```

通过 Worker / Durable Object 发给设备 B。

设备 B：

```text
setRemoteDescription
createAnswer
setLocalDescription
```

Answer 再通过 Durable Object 返回设备 A。

双方继续交换：

```text
ICE Candidate
```

直到 WebRTC 建立成功。

---

# 10. 禁止 TURN 文件中继

本项目核心要求：

```text
文件不得经过中继服务器。
```

因此第一版不要配置 TURN。

允许使用：

```text
STUN
```

用于 ICE / NAT 探测。

但是：

```text
禁止 TURN fallback
```

如果 WebRTC 无法直接连接：

```text
连接失败

无法建立 P2P 直连。
当前网络环境可能阻止设备直接通信。
```

不要自动通过服务器转发文件。

---

# 11. P2P 状态检测

连接成功以后，应检测：

```text
RTCPeerConnection.getStats()
```

获取当前 selected candidate pair。

尽可能判断：

```text
host
srflx
relay
```

如果发现：

```text
relay
```

说明使用了 TURN。

必须：

```text
停止文件传输
```

并提示：

```text
当前连接不是 P2P 直连。

为了保证文件不经过中继服务器，
本次传输已禁止。
```

正常状态：

```text
🟢 P2P 直连
```

---

# 12. 文件选择

支持：

```text
选择文件
拖放文件
选择多个文件
```

后续支持：

```text
选择文件夹
```

例如：

```text
照片/
视频/
文档/
backup.zip
```

---

# 13. 发送确认

设备 A 选择文件以后：

```text
backup.zip
12.8 GB
```

设备 B 显示：

```text
DESKTOP-A 请求向你发送文件

backup.zip

大小：
12.8 GB

[接受]

[拒绝]
```

必须由接收方确认后才能开始发送。

---

# 14. 文件传输协议

禁止：

```text
一次读取整个文件进入内存
```

必须采用：

```text
分块读取
+
分块发送
```

例如：

```text
File
 ↓
Slice
 ↓
64 KB Chunk
 ↓
RTCDataChannel
 ↓
Receiver
```

Chunk Size 第一版根据 SCTP 协商结果动态计算：

```text
不超过 min(64 KB, RTCSctpTransport.maxMessageSize) - Header Size
```

但必须设计成常量，方便以后调优。

例如：

```javascript
const chunkPayloadSize = chooseChunkPayloadSize(peerConnection.sctp?.maxMessageSize);
```

---

# 15. DataChannel 配置

优先保证文件完整性。

建议：

```javascript
ordered: true
```

不要为了速度牺牲文件可靠性。

文件数据必须按照正确顺序重组。

---

# 16. 流量控制

必须同时实现网络和磁盘两层背压：

```text
bufferedAmount
接收端 committedOffset ACK
```

控制。

不能无限调用：

```javascript
dataChannel.send()
```

否则大文件会造成：

```text
浏览器内存暴涨
浏览器卡顿
DataChannel 断开
```

例如（仅网络发送队列部分）：

```javascript
const MAX_BUFFERED_AMOUNT = 8 * 1024 * 1024;
```

逻辑：

```text
bufferedAmount < 8MB
        ↓
继续读取和发送

bufferedAmount >= 8MB
        ↓
暂停发送

等待 bufferedamountlow
        ↓
继续发送
```

设置：

```javascript
dataChannel.bufferedAmountLowThreshold
```

使用：

```text
bufferedamountlow
```

事件恢复发送。

---

# 17. 文件元数据

文件发送前先发送 Metadata。

例如：

```json
{
  "type": "file-meta",
  "fileId": "uuid",
  "name": "backup.zip",
  "size": 13743895347,
  "mimeType": "application/zip",
  "relativePath": "",
  "chunkSize": 65536
}
```

接收方确认：

```json
{
  "type": "file-accept",
  "fileId": "uuid"
}
```

或者：

```json
{
  "type": "file-reject",
  "fileId": "uuid"
}
```

---

# 18. 数据类型区分

DataChannel 中需要区分：

```text
控制消息
文件数据
```

控制消息可以使用 JSON。

例如：

```text
file-meta
file-accept
file-reject
file-start
file-complete
file-error
resume-request
hash
```

真正文件数据：

```text
ArrayBuffer
```

不要把文件块转换为：

```text
Base64
```

因为 Base64 会增加数据量和 CPU 开销。

---

# 19. 大文件支持

目标至少支持：

```text
1 GB
10 GB
50 GB
100 GB
```

架构不得存在：

```text
文件大小 = 内存占用
```

必须：

```text
Streaming / Chunking
```

使内存占用保持相对稳定。

---

# 20. 接收端文件处理

需要特别注意：

不能把 100GB 文件的所有 Chunk 全部存入：

```javascript
const chunks = [];
```

然后最后：

```javascript
new Blob(chunks)
```

这会导致浏览器内存爆炸。

必须优先研究并实现：

```text
浏览器流式写入文件
```

可以根据浏览器能力使用：

```text
File System Access API
WritableStream
showSaveFilePicker()
```

支持该 API 的浏览器：

```text
边接收
边写入磁盘
```

目标：

```text
网络收到 Chunk
       ↓
WritableStream
       ↓
直接写磁盘
```

避免整个文件驻留内存。

如果浏览器不支持流式磁盘写入：

应明确提示：

```text
当前浏览器不支持超大文件流式保存。

建议使用最新版 Chrome / Edge。
```

不要为了兼容性而偷偷把几十 GB 文件全部放进内存。

---

# 21. 传输进度

页面实时显示：

```text
backup.zip

██████████████░░░░░░

32.7 GB / 50 GB

65.4%
```

---

# 22. 实时速度

至少每秒计算一次：

```text
本周期新增传输字节数
÷
时间
```

显示：

```text
96.8 MB/s
```

同时计算平均速度。

---

# 23. ETA

根据：

```text
剩余字节
÷
当前平滑传输速度
```

计算：

```text
预计剩余：

3 分 02 秒
```

速度最好使用短时间移动平均，避免 ETA 疯狂跳动。

---

# 24. 连接状态

页面必须明确显示：

```text
连接状态：

🟢 P2P 直连
```

以及：

```text
对方设备：
DESKTOP-B
```

可以的话显示：

```text
连接类型：
LAN / P2P
```

但不要把隐私敏感网络信息不必要地暴露给其他用户。

---

# 25. SHA-256 校验

文件传输完成后进行：

```text
SHA-256
```

完整性验证。

发送方：

```text
Original File
      ↓
SHA-256
      ↓
Hash
```

接收方：

```text
Received File
      ↓
SHA-256
      ↓
Hash
```

比较：

```text
Sender Hash
Receiver Hash
```

一致：

```text
✓ 文件完整
```

不一致：

```text
✕ 文件校验失败
```

SHA-256 计算也必须考虑大文件。

不要为了计算 Hash 把整个文件一次性读取到内存。

应采用：

```text
增量 / 流式 Hash
```

如果 Web Crypto API 无法直接满足增量 Hash，需要选择适合浏览器的大文件增量 SHA-256 实现。

---

# 26. 多文件队列

支持：

```text
video.mp4
backup.zip
photo.jpg
document.pdf
```

显示：

```text
文件                    大小       状态

video.mp4              8.7GB      传输中 73%
backup.zip             12GB       等待
photo.jpg              8MB        等待
document.pdf           20MB       等待
```

第一版可以：

```text
一次只传输一个文件
```

一个完成后再传下一个。

这样更容易保证：

```text
稳定性
速度
内存控制
```

---

# 27. 文件夹支持

支持浏览器：

```text
webkitdirectory
```

或者合适的 File System Access API。

发送：

```text
Project/
├── images/
│   ├── 1.jpg
│   └── 2.jpg
├── video/
│   └── demo.mp4
└── README.md
```

Metadata 保存：

```text
relativePath
```

接收端恢复原始目录结构。

---

# 28. 断点续传

架构必须预留断点续传。

每个文件拥有：

```text
fileId
```

记录：

```text
文件大小
文件名
已接收 Offset
Chunk Size
Hash / Fingerprint
```

例如：

```text
50GB 文件

已经收到：

37GB
```

连接中断。

重新建立连接以后：

接收方发送：

```json
{
  "type": "resume-request",
  "fileId": "uuid",
  "offset": 39728447488
}
```

发送方从：

```text
37GB Offset
```

继续读取。

不要重新从：

```text
0GB
```

开始。

第一版如果暂时不实现完整断点续传，也必须保证协议设计以后能够增加。

---

# 29. 断线处理

监听：

```text
connectionstatechange
iceconnectionstatechange
datachannel close
WebSocket close
```

出现：

```text
disconnected
failed
closed
```

停止读取文件。

不要继续向 DataChannel 写入。

UI 显示：

```text
连接已断开

已传输：
37.2 GB / 50 GB

等待重新连接……
```

---

# 30. 配对安全

配对码：

```text
6 位随机数字
```

必须使用安全随机数生成方式。

不要简单使用：

```javascript
Math.random()
```

优先：

```javascript
crypto.getRandomValues()
```

房间：

```text
5分钟未连接
↓
自动失效
```

成功建立两人房间以后：

```text
禁止第三人加入
```

---

# 31. 接收确认

任何文件都不能：

```text
自动下载
```

必须：

```text
发送方请求
↓
接收方确认
↓
开始传输
```

---

# 32. UI 页面

整体 UI 保持：

```text
简单
现代
响应式
手机可用
桌面可用
```

首页：

```text
┌─────────────────────────────┐
│                             │
│       P2P 文件互传          │
│                             │
│   无需安装 · 局域网直传     │
│                             │
│      [ 创建连接 ]           │
│                             │
│  ───────── 或 ─────────     │
│                             │
│  输入配对码                 │
│                             │
│  [ 827361 ]                 │
│                             │
│      [ 连接设备 ]           │
│                             │
└─────────────────────────────┘
```

---

# 33. 配对页面

```text
┌─────────────────────────────┐

       等待设备连接

       配对码

       827361

   配对码将在 04:32 后失效

       [复制配对码]

└─────────────────────────────┘
```

后续可以增加：

```text
二维码
```

手机扫码直接加入。

---

# 34. 传输页面

```text
┌──────────────────────────────────┐

 对方设备：DESKTOP-B

 🟢 P2P 直连

──────────────────────────────────

 将文件拖到这里

        或

     [选择文件]

──────────────────────────────────

 backup.zip

 32.7 GB / 50 GB

 ███████████████░░░░░

 65.4%

 速度：96.8 MB/s

 剩余：3分02秒

──────────────────────────────────

 SHA-256：

 正在计算 / 校验……

└──────────────────────────────────┘
```

---

# 35. 手机适配

页面必须支持：

```text
Chrome Android
Edge Android
Safari iOS
```

但是部分浏览器可能不支持：

```text
File System Access API
```

需要进行：

```javascript
feature detection
```

而不是单纯判断 User-Agent。

例如：

```text
支持流式磁盘写入
→ 允许超大文件

不支持
→ 给出兼容性提示
```

---

# 36. 性能目标

千兆局域网：

```text
理论：
125 MB/s

目标：
尽可能达到 80～110 MB/s
```

实际速度受以下因素影响：

```text
网卡
交换机
Wi-Fi
磁盘
CPU
浏览器
WebRTC实现
```

不要人为设置：

```text
10MB/s
20MB/s
```

之类的速度限制。

---

# 37. 性能优化

需要考虑：

```text
Chunk Size
bufferedAmount
磁盘读取速度
磁盘写入速度
DataChannel Buffer
GC
ArrayBuffer 创建数量
```

避免大量：

```text
Array copy
Blob copy
Base64 encode
JSON encode binary
```

文件数据始终优先：

```text
ArrayBuffer
```

---

# 38. Worker 不得处理文件

Worker API 必须严格限制用途。

例如允许：

```text
GET /
GET /assets/*
GET /ws/:room
POST /room
```

不要实现：

```text
POST /upload
POST /file
GET /download
```

整个项目不应该存在服务器文件上传接口。

---

# 39. Durable Object 职责

每一个配对房间对应一个 Durable Object。

例如：

```text
Room 827361
```

内部最多保存：

```text
Peer A WebSocket
Peer B WebSocket
创建时间
房间状态
```

只负责：

```text
Signaling Relay
```

不要保存：

```text
文件
文件 Chunk
文件内容
```

---

# 40. 房间生命周期

状态：

```text
CREATED
↓
WAITING
↓
PAIRED
↓
CONNECTED
↓
CLOSED
```

超时：

```text
WAITING > 5 minutes
↓
CLOSED
```

双方离开：

```text
CLOSED
```

---

# 41. WebSocket 消息

建议定义统一协议：

```typescript
type SignalingMessage =
  | {
      type: "peer-joined";
    }
  | {
      type: "offer";
      payload: RTCSessionDescriptionInit;
    }
  | {
      type: "answer";
      payload: RTCSessionDescriptionInit;
    }
  | {
      type: "ice-candidate";
      payload: RTCIceCandidateInit;
    }
  | {
      type: "peer-left";
    };
```

---

# 42. DataChannel 控制协议

例如：

```typescript
type ControlMessage =
  | {
      type: "file-meta";
      fileId: string;
      name: string;
      size: number;
      mimeType: string;
      relativePath?: string;
      chunkSize: number;
    }
  | {
      type: "file-accept";
      fileId: string;
    }
  | {
      type: "file-reject";
      fileId: string;
    }
  | {
      type: "file-complete";
      fileId: string;
    }
  | {
      type: "resume-request";
      fileId: string;
      offset: number;
    }
  | {
      type: "hash";
      fileId: string;
      algorithm: "SHA-256";
      hash: string;
    };
```

---

# 43. 二进制 Chunk 协议

不要依赖：

```text
每个 DataChannel message
=
天然知道属于哪个文件
```

需要定义简单的二进制 Header。

例如：

```text
Header
+
Payload
```

Header 至少包含：

```text
File ID
Offset
Payload Length
```

这样可以：

```text
检测 Chunk
恢复 Offset
实现断点续传
```

第一版也可以在：

```text
一次只传一个文件
```

的前提下简化协议。

但是架构必须能够扩展。

---

# 44. 错误处理

必须处理：

```text
配对码不存在
配对码过期
房间已满
WebSocket断开
WebRTC连接失败
DataChannel关闭
文件读取失败
磁盘写入失败
接收方空间不足
SHA-256失败
用户取消
浏览器刷新
```

所有错误都需要：

```text
明确 UI 提示
```

不要只：

```javascript
console.error()
```

---

# 45. 隐私原则

项目不得：

```text
上传文件名到长期数据库
保存文件
记录文件内容
分析文件
上传文件Hash
```

除非完成当前 P2P 协议确实需要。

Cloudflare 只处理临时：

```text
房间
WebRTC信令
连接状态
```

房间关闭后：

```text
清理临时状态
```

---

# 46. 第一阶段 MVP

Codex 首先实现 MVP。

MVP 必须完成：

```text
1. Cloudflare Worker
2. Durable Object
3. 创建6位配对码
4. 加入配对码
5. WebSocket信令
6. WebRTC连接
7. RTCDataChannel
8. 单文件发送
9. 分块发送
10. bufferedAmount流量控制
11. 接收方确认
12. 流式磁盘写入
13. 进度显示
14. 实时速度显示
15. P2P连接状态
16. 禁止TURN
17. 基本错误处理
18. 响应式UI
```

MVP 暂时可以不实现：

```text
文件夹
二维码
完整断点续传
多文件并发
传输历史
账号系统
```

---

# 47. 第二阶段

增加：

```text
多文件队列
文件夹
二维码配对
SHA-256
断点续传
更完善的网络状态检测
传输速度优化
移动端优化
```

---

# 48. 第三阶段

进一步考虑：

```text
PWA
局域网设备友好名称
剪贴板文字互传
图片预览
发送历史（仅本地）
主题切换
多语言
```

---

# 49. 不允许改变的核心要求

Codex 在实现过程中不得为了简化开发，将架构改成：

```text
浏览器
↓
Worker上传
↓
R2
↓
另一设备下载
```

也不得：

```text
浏览器
↓
Worker Proxy
↓
浏览器
```

文件必须：

```text
Browser A
↓
WebRTC DataChannel
↓
Browser B
```

Cloudflare 永远只负责：

```text
网页
+
信令
```

---

# 50. 项目验收标准

必须进行实际测试。

## 测试一：基本配对

```text
电脑 A 打开网页
电脑 B 打开网页

输入配对码

成功建立连接
```

---

## 测试二：局域网直连

两台设备连接同一交换机。

确认：

```text
WebRTC Candidate Pair
```

没有：

```text
relay
```

页面显示：

```text
🟢 P2P直连
```

---

## 测试三：关闭 Cloudflare 信令后的现有传输

WebRTC DataChannel 成功建立以后：

```text
暂时断开信令 WebSocket
```

已有 P2P DataChannel 在网络条件允许的情况下不应该因为信令 WebSocket 单独断开而立即终止文件数据路径。

用于验证：

```text
文件数据不经过 Worker WebSocket
```

---

## 测试四：1GB 文件

发送：

```text
1GB
```

验证：

```text
文件完整
浏览器内存稳定
速度正常
```

---

## 测试五：10GB 文件

发送：

```text
10GB
```

验证：

```text
不会把整个文件加载到内存
不会浏览器崩溃
不会明显内存持续增长
```

---

## 测试六：50GB 文件

如果测试环境允许：

```text
50GB
```

验证：

```text
长时间稳定传输
接收端直接写磁盘
内存保持合理
```

---

## 测试七：千兆速度

两台：

```text
1GbE
```

电脑连接千兆交换机。

使用 SSD。

目标：

```text
尽可能接近局域网实际吞吐能力
```

不要因为：

```text
Chunk过小
JS逻辑
bufferedAmount配置
```

造成明显人为瓶颈。

---

# 51. 开发优先级

优先级从高到低：

```text
P0

真正P2P
文件不经过服务器
大文件稳定
内存稳定
文件完整

P1

高速
进度
速度
错误恢复
良好UI

P2

断点续传
文件夹
二维码
SHA-256

P3

PWA
主题
历史
其他体验功能
```

---

# 52. 最终目标

最终用户体验应该非常简单：

```text
打开网页
   ↓
创建配对码
   ↓
另一台设备输入配对码
   ↓
双方建立P2P连接
   ↓
选择 / 拖入文件
   ↓
对方点击接受
   ↓
局域网高速传输
   ↓
直接写入对方磁盘
   ↓
完成
```

整个过程中：

```text
无需安装客户端
无需注册账号
无需上传云端
无需服务器存储
```

最终核心数据路径：

```text
┌─────────────┐                       ┌─────────────┐
│             │                       │             │
│  Browser A  │ ===================== │  Browser B  │
│             │    WebRTC P2P         │             │
└─────────────┘    DataChannel        └─────────────┘
       │                                   │
       │                                   │
       └──────── Cloudflare ───────────────┘
                 Signaling Only
```

**Cloudflare 用来让两台设备找到彼此。**

**WebRTC 用来让两台设备直接传输文件。**

这是整个项目最重要、不得改变的设计原则。
