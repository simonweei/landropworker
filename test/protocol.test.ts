import { describe, expect, it } from "vitest";
import {
  HEADER_SIZE,
  MAX_DATA_MESSAGE_SIZE,
  chooseChunkPayloadSize,
  decodeChunk,
  describeFileSystemError,
  encodeChunk,
  formatBytes,
  receivedNameCandidate,
  suggestedReceivedName,
} from "../src/client/protocol";

describe("binary file protocol", () => {
  it("round-trips a chunk without losing its 64-bit offset", () => {
    const fileId = "123e4567-e89b-12d3-a456-426614174000";
    const payload = new Uint8Array([1, 2, 3, 4]).buffer;
    const encoded = encodeChunk(fileId, 100 * 1024 ** 3, payload);
    const decoded = decodeChunk(encoded);

    expect(encoded.byteLength).toBe(HEADER_SIZE + 4);
    expect(decoded.fileId).toBe(fileId);
    expect(decoded.offset).toBe(100 * 1024 ** 3);
    expect(Array.from(new Uint8Array(decoded.payload))).toEqual([1, 2, 3, 4]);
  });

  it("keeps the complete message below the negotiated SCTP limit", () => {
    const payloadSize = chooseChunkPayloadSize(65_536);
    expect(payloadSize + HEADER_SIZE).toBe(65_536);
    expect(payloadSize + HEADER_SIZE).toBeLessThanOrEqual(MAX_DATA_MESSAGE_SIZE);
  });

  it("rejects malformed and oversized frames", () => {
    expect(() => decodeChunk(new ArrayBuffer(8))).toThrow("文件分块头不完整");
    expect(() => encodeChunk("bad-id", 0, new ArrayBuffer(1))).toThrow("无效的文件 ID");
    expect(() => chooseChunkPayloadSize(512)).toThrow("消息上限过小");
  });

  it("formats user-facing sizes", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(10 * 1024 ** 3)).toBe("10.0 GB");
  });

  it("preserves the original filename", () => {
    expect(suggestedReceivedName("archive.iso")).toBe("archive.iso");
    expect(suggestedReceivedName("中文文件名.zip")).toBe("中文文件名.zip");
  });

  it("creates safe non-overwriting names in a shared receive folder", () => {
    expect(receivedNameCandidate("archive.tar.gz", 1)).toBe("archive.tar (1).gz");
    expect(receivedNameCandidate("README", 2)).toBe("README (2)");
    expect(receivedNameCandidate("../unsafe.txt")).toBe(".._unsafe.txt");
  });

  it("turns Chromium file state failures into actionable guidance", () => {
    const error = new DOMException("cached state changed", "InvalidStateError");
    const message = describeFileSystemError(error, 8 * 1024 ** 3);
    expect(message).toContain("不要覆盖已有文件");
    expect(message).toContain("8.0 GB");
  });

  it("explains exclusive file lock failures", () => {
    const error = new DOMException("locked", "NoModificationAllowedError");
    expect(describeFileSystemError(error, 1)).toContain("其他标签页或程序");
  });
});
