import assert from "node:assert/strict";
import test from "node:test";
import {
  createPdfBillParser,
  pdfBillAttachmentPolicy,
} from "./bill-pdf-parser.mjs";

const attachment = {
  mimeType: "application/pdf",
  data: Buffer.from("%PDF-1.7"),
};
const document = {
  complete: true,
  pageCount: 1,
  pages: [
    {
      pageNumber: 1,
      method: "native+vision",
      nativeText: "bill",
      visionText: "bill",
    },
  ],
};
test("PDF adapter preserves complete per-page evidence and forwards the live authorization check", async () => {
  const signal = new AbortController().signal;
  let checks = 0;
  const assertActive = async () => {
    checks++;
  };
  const facts = { invoiceId: "one" };
  const parse = createPdfBillParser({
    pdfService: {
      extractCompleteDocument: async (bytes, options) => {
        assert.equal(bytes, attachment.data);
        assert.equal(options.assertActive, assertActive);
        assert.equal(options.signal, signal);
        await options.assertActive();
        return document;
      },
    },
    mapDocument: async (value, context, control) => {
      assert.equal(value, document);
      assert.equal(context.accountId, "google-a");
      assert.equal(control.assertActive, assertActive);
      assert.equal(control.signal, signal);
      return facts;
    },
  });
  assert.equal(
    await parse(
      attachment,
      { accountId: "google-a" },
      { assertActive, signal },
    ),
    facts,
  );
  assert.equal(checks, 4);
  assert.equal(pdfBillAttachmentPolicy(attachment), "read");
  assert.equal(
    pdfBillAttachmentPolicy({ mimeType: "image/png" }),
    "unsupported",
  );
});
test("PDF adapter rejects partial or text-only documents before interpreting bill facts", async () => {
  for (const value of [
    { ...document, complete: false },
    { ...document, pageCount: 2 },
    { ...document, pages: [{ ...document.pages[0], visionText: "" }] },
    { ...document, pages: [{ ...document.pages[0], pageNumber: 2 }] },
  ]) {
    let interpreted = false;
    const parse = createPdfBillParser({
      pdfService: { extractCompleteDocument: async () => value },
      mapDocument: () => {
        interpreted = true;
      },
    });
    await assert.rejects(
      parse(attachment, {}, { assertActive: async () => {} }),
    );
    assert.equal(interpreted, false);
  }
});
test("PDF adapter discards extraction and interpretation results after task revocation", async () => {
  for (const stage of ["extract", "interpret"]) {
    let active = true,
      interpreted = false;
    const assertActive = async () => {
      if (!active) throw new Error("revoked");
    };
    const parse = createPdfBillParser({
      pdfService: {
        extractCompleteDocument: async () => {
          if (stage === "extract") active = false;
          return document;
        },
      },
      mapDocument: async () => {
        interpreted = true;
        active = false;
        return { invoiceId: "late" };
      },
    });
    await assert.rejects(parse(attachment, {}, { assertActive }), /revoked/);
    assert.equal(interpreted, stage === "interpret");
  }
});
