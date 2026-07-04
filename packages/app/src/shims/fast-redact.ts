/**
 * Browser-bundle shim aliased in place of `fast-redact` (a pino transitive dep).
 * Log redaction is a no-op in the renderer: the factory always returns an
 * identity redactor with an identity `restore`, satisfying the call signature
 * without shipping the real string-path compiler or mutating any payload.
 */
type FastRedactOptions = {
  paths?: string[];
  serialize?: false | ((value: unknown) => string);
};

type Redactor = ((value: unknown) => unknown) & {
  restore?: (value: unknown) => unknown;
};

const noopRedactor: Redactor = (value: unknown) => value;
noopRedactor.restore = (value: unknown) => value;

export default function fastRedact(options: FastRedactOptions = {}): Redactor {
  if (!options.paths?.length) {
    return noopRedactor;
  }

  return noopRedactor;
}
