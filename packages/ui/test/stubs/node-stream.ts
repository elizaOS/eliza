// Stub for `node:stream` in the Storybook browser catalog. Only `Readable` is
// imported by the reachable chain; provide a minimal class so module init and
// `instanceof`/subclassing succeed. Real streaming never runs during a render.
const notAvailable = (name: string) => {
  throw new Error(`node:stream stub cannot ${name} in Storybook`);
};

export class Readable {
  static from() {
    return new Readable();
  }
  on() {
    return this;
  }
  once() {
    return this;
  }
  pipe() {
    return notAvailable("pipe");
  }
  read() {
    return null;
  }
  destroy() {
    return this;
  }
}
export class Writable {
  write() {
    return notAvailable("write");
  }
  end() {
    return this;
  }
  on() {
    return this;
  }
}
export class Duplex extends Readable {}
export class Transform extends Readable {}
export class PassThrough extends Readable {}
export const pipeline = () => notAvailable("pipeline");
export const finished = () => notAvailable("finished");

export default {
  Readable,
  Writable,
  Duplex,
  Transform,
  PassThrough,
  pipeline,
  finished,
};
