/** Bounded descriptor JSON parser. Signature verification must use the original
 * authenticated target bytes; this parser does not implement TUF canonical JSON. */
export function parseDescriptorJson(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 1024 * 1024)
    throw Error("Descriptor size exceeds limit");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let i = 0;
  const fail = () => {
    throw Error(`Invalid descriptor JSON at offset ${i}`);
  };
  const whitespace = () => {
    while (/[\x20\t\r\n]/.test(text[i] ?? "!")) i++;
  };
  function string() {
    const start = i;
    if (text[i++] !== '"') fail();
    while (i < text.length) {
      const c = text[i++];
      if (c === '"') {
        const result = JSON.parse(text.slice(start, i));
        if (result.length > 4096 || !result.isWellFormed()) fail();
        return result;
      }
      if (c === "\\") i++;
    }
    fail();
  }
  function value(depth) {
    if (depth > 32) fail();
    whitespace();
    const c = text[i];
    if (c === '"') return string();
    if (c === "{") {
      i++;
      const result = Object.create(null);
      let count = 0;
      whitespace();
      if (text[i] === "}") {
        i++;
        return result;
      }
      while (true) {
        whitespace();
        const key = string();
        if (Object.hasOwn(result, key) || ++count > 256) fail();
        whitespace();
        if (text[i++] !== ":") fail();
        result[key] = value(depth + 1);
        whitespace();
        const end = text[i++];
        if (end === "}") return result;
        if (end !== ",") fail();
      }
    }
    if (c === "[") {
      i++;
      const result = [];
      whitespace();
      if (text[i] === "]") {
        i++;
        return result;
      }
      while (true) {
        if (result.length >= 4096) fail();
        result.push(value(depth + 1));
        whitespace();
        const end = text[i++];
        if (end === "]") return result;
        if (end !== ",") fail();
      }
    }
    for (const [literal, result] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ])
      if (text.startsWith(literal, i)) {
        i += literal.length;
        return result;
      }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(
      text.slice(i),
    );
    if (number) {
      i += number[0].length;
      const n = Number(number[0]);
      if (
        !Number.isSafeInteger(n) ||
        /[.eE]/.test(number[0]) ||
        Object.is(n, -0)
      )
        fail();
      return n;
    }
    fail();
  }
  const result = value(0);
  whitespace();
  if (i !== text.length) fail();
  return result;
}
