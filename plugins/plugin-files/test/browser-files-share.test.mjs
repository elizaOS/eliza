import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { crc32 } from "node:zlib";
import { MAX_CHAT_IMAGE_INTAKE_BYTES } from "../../../packages/core/src/chat-upload-limits.ts";
import { BrowserFiles } from "../src/browser/files.ts";

const previousNavigator = Object.getOwnPropertyDescriptor(
  globalThis,
  "navigator",
);
const previousDocument = Object.getOwnPropertyDescriptor(
  globalThis,
  "document",
);

test("selected chat bytes keep the mail bound, exact content and revision fence", async () => {
  const bytes = new Uint8Array(5 * 1024 * 1024 + 1);
  bytes[0] = 42;
  bytes[bytes.length - 1] = 91;
  const row = {
    id: "selected",
    name: "notes.txt",
    mimeType: "text/plain",
    revision: "one",
    blob: new Blob([bytes]),
    size: bytes.length,
  };
  const files = new BrowserFiles({}, { entries: async () => [row] });
  const selected = await files.select({ id: row.id });
  try {
    await assert.rejects(files.attachment(selected), /5 MiB/);
    await assert.rejects(
      files.attachment({ ...selected, purpose: "mail" }),
      /5 MiB/,
    );
    const result = await files.attachment({ ...selected, purpose: "chat" });
    assert.deepEqual(
      Buffer.from(result.dataBase64, "base64"),
      Buffer.from(bytes),
    );
    await assert.rejects(
      files.attachment({ ...selected, purpose: "unknown" }),
      /Unknown attachment purpose/,
    );
    row.blob = new Blob([new Uint8Array(MAX_CHAT_IMAGE_INTAKE_BYTES + 1)]);
    row.size = 0; // Provider metadata cannot bypass the actual Blob bound.
    await assert.rejects(
      files.attachment({ ...selected, purpose: "chat" }),
      /20 MiB/,
    );
    row.blob = {
      size: 1,
      arrayBuffer: async () => {
        row.revision = "two";
        return new Uint8Array([7]).buffer;
      },
    };
    await assert.rejects(
      files.attachment({ ...selected, purpose: "chat" }),
      /Select this file again/,
    );
    row.revision = "one";
    row.blob = {
      size: 1,
      arrayBuffer: async () => {
        await files.forgetSelected(selected);
        return new Uint8Array([7]).buffer;
      },
    };
    await assert.rejects(
      files.attachment({ ...selected, purpose: "chat" }),
      /Select this file again/,
    );
  } finally {
    URL.revokeObjectURL(selected.uri);
  }
});
afterEach(() => {
  mock.restoreAll();
  for (const [name, previous] of [
    ["navigator", previousNavigator],
    ["document", previousDocument],
  ]) {
    if (previous) Object.defineProperty(globalThis, name, previous);
    else delete globalThis[name];
  }
});

function fixture() {
  const binary = new Uint8Array([0, 255, 1, 128, 13, 10]);
  const rows = [
    {
      id: "folder",
      parentId: "root",
      name: "Résumé",
      directory: true,
      revision: "r1",
    },
    {
      id: "file",
      parentId: "folder",
      name: "二.bin",
      directory: false,
      revision: "r2",
      blob: new Blob([binary]),
    },
    {
      id: "empty",
      parentId: "folder",
      name: "Empty",
      directory: true,
      revision: "r3",
    },
  ];
  const files = new BrowserFiles(
    { archiveName: "Selection.zip" },
    { entries: async () => rows },
  );
  const input = { items: [{ id: "folder", expectedRevision: "r1" }] };
  const calls = {
    canShare: [],
    shared: [],
    downloaded: [],
    urls: [],
    revoked: [],
    timers: [],
  };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      canShare(data) {
        calls.canShare.push(data);
        return true;
      },
      async share(data) {
        calls.shared.push(data);
      },
    },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      body: { append() {} },
      createElement(tag) {
        assert.equal(tag, "a");
        return {
          click() {
            calls.downloaded.push(this.download);
          },
          remove() {},
        };
      },
    },
  });
  mock.method(URL, "createObjectURL", (blob) => {
    calls.urls.push(blob);
    return "blob:controlled-archive";
  });
  mock.method(URL, "revokeObjectURL", (url) => {
    calls.revoked.push(url);
  });
  mock.method(globalThis, "setTimeout", (callback, delay) => {
    calls.timers.push({ callback, delay });
    return 1;
  });
  return { files, input, rows, calls, binary };
}

async function archiveEntries(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer()),
    view = new DataView(bytes.buffer),
    entries = [];
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    const crc = view.getUint32(offset + 14, true),
      size = view.getUint32(offset + 18, true),
      nameLength = view.getUint16(offset + 26, true),
      extra = view.getUint16(offset + 28, true);
    const name = new TextDecoder().decode(
      bytes.subarray(offset + 30, offset + 30 + nameLength),
    );
    const start = offset + 30 + nameLength + extra,
      data = bytes.slice(start, start + size);
    assert.equal(crc32(data), crc, "stored ZIP CRC matches exact bytes");
    entries.push({ name, bytes: [...data] });
    offset = start + size;
  }
  assert.equal(
    view.getUint32(offset, true),
    0x02014b50,
    "central directory follows stored entries",
  );
  assert.equal(
    view.getUint32(bytes.length - 22, true),
    0x06054b50,
    "ZIP end record retained",
  );
  assert.equal(view.getUint16(bytes.length - 12, true), entries.length);
  return entries;
}

test("bulk share hands one actual ZIP File to Web Share with exact nested Unicode bytes and empty folders", async () => {
  const { files, input, calls, binary } = fixture();
  const result = await files.shareMany(input);
  assert.equal(result.status, "opened");
  assert.equal(calls.canShare.length, 1);
  assert.equal(calls.shared.length, 1);
  assert.equal(calls.canShare[0].files[0], calls.shared[0].files[0]);
  const file = calls.shared[0].files[0];
  assert.ok(file instanceof File);
  assert.equal(file.name, "Selection.zip");
  assert.equal(file.type, "application/zip");
  assert.deepEqual(await archiveEntries(file), [
    { name: "Résumé/", bytes: [] },
    { name: "Résumé/二.bin", bytes: [...binary] },
    { name: "Résumé/Empty/", bytes: [] },
  ]);
  assert.deepEqual(calls.downloaded, []);
  assert.deepEqual(calls.urls, []);
});

test("explicit bulk save downloads the same archive and revokes only its own object URL", async () => {
  const { files, input, calls, binary } = fixture();
  await files.saveMany(input);
  assert.deepEqual(calls.downloaded, ["Selection.zip"]);
  assert.deepEqual(calls.shared, []);
  assert.deepEqual(calls.canShare, []);
  assert.deepEqual(await archiveEntries(calls.urls[0]), [
    { name: "Résumé/", bytes: [] },
    { name: "Résumé/二.bin", bytes: [...binary] },
    { name: "Résumé/Empty/", bytes: [] },
  ]);
  assert.equal(calls.timers.length, 1);
  assert.equal(calls.timers[0].delay, 60000);
  calls.timers[0].callback();
  assert.deepEqual(calls.revoked, ["blob:controlled-archive"]);
});

for (const unsupported of [
  "missing-share",
  "missing-canShare",
  "refused-files",
]) {
  test(`unsupported bulk sharing (${unsupported}) never downloads or retries`, async () => {
    const { files, input, calls } = fixture();
    if (unsupported === "missing-share") delete navigator.share;
    else if (unsupported === "missing-canShare") delete navigator.canShare;
    else navigator.canShare = () => false;
    await assert.rejects(
      files.shareMany(input),
      /Sharing is unavailable in this browser/,
    );
    assert.deepEqual(calls.shared, []);
    assert.deepEqual(calls.downloaded, []);
    assert.deepEqual(calls.urls, []);
  });
}

test("Web Share cancellation propagates the original AbortError without downloading or retrying", async () => {
  const { files, input, calls } = fixture(),
    cancelled = new DOMException("Cancelled", "AbortError");
  navigator.share = async (data) => {
    calls.shared.push(data);
    throw cancelled;
  };
  await assert.rejects(files.shareMany(input), (error) => error === cancelled);
  assert.equal(calls.shared.length, 1);
  assert.deepEqual(calls.downloaded, []);
  assert.deepEqual(calls.urls, []);
});

test("Web Share refusal propagates once without a save fallback", async () => {
  const { files, input, calls } = fixture(),
    refused = new DOMException("Not allowed", "NotAllowedError");
  navigator.share = async (data) => {
    calls.shared.push(data);
    throw refused;
  };
  await assert.rejects(files.shareMany(input), (error) => error === refused);
  assert.equal(calls.shared.length, 1);
  assert.deepEqual(calls.downloaded, []);
  assert.deepEqual(calls.urls, []);
});

for (const method of ["shareMany", "saveMany"]) {
  test(`${method} rejects stale selections and unsafe archive paths before any destination dispatch`, async () => {
    const { files, input, rows, calls } = fixture();
    rows[0].revision = "changed";
    await assert.rejects(files[method](input), /selected file changed/);
    rows[0].revision = "r1";
    rows[0].name = "..";
    await assert.rejects(files[method](input), /relative archive paths/);
    assert.deepEqual(calls.canShare, []);
    assert.deepEqual(calls.shared, []);
    assert.deepEqual(calls.downloaded, []);
    assert.deepEqual(calls.urls, []);
  });
}
