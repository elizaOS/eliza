import type { Socket } from "node:net";
import { loadLinuxInstallerNativeBinding } from "./linux-native-binding";
import type {
  KernelBoundPeerProcessHandle,
  KernelUnixPeerCredentials,
  LinuxUnixPeerCredentialProvider,
} from "./unix-transport";

interface NativePeerProcess {
  readonly pid: number;
  readonly uid: number;
  readonly gid: number;
  isAlive(): boolean;
  close(): void;
}

export interface LinuxPeerCredentialNativeBinding {
  capture(socketDescriptor: number): NativePeerProcess;
}

interface NodeSocketHandle {
  readonly fd?: unknown;
}

function acceptedSocketDescriptor(socket: Socket): number {
  // Node does not publish a stable fd accessor for net.Socket. This is the
  // descriptor owned by this already-accepted Socket; it is consumed only by
  // the synchronous native call and is never accepted from request data.
  const handle = (socket as Socket & { _handle?: NodeSocketHandle })._handle;
  const descriptor = handle?.fd;
  if (!Number.isSafeInteger(descriptor) || (descriptor as number) < 0) {
    throw new Error(
      "Installer cannot obtain the accepted AF_UNIX socket descriptor.",
    );
  }
  return descriptor as number;
}

class NativePidfdProcessHandle implements KernelBoundPeerProcessHandle {
  readonly pid: number;
  readonly native: NativePeerProcess;

  constructor(native: NativePeerProcess) {
    this.native = native;
    this.pid = native.pid;
  }

  async isAlive(): Promise<boolean> {
    return this.native.isAlive();
  }

  close(): void {
    this.native.close();
  }
}

/**
 * Production Linux peer identity provider. Construction fails closed when the
 * packaged N-API module is missing. Inspection is entirely synchronous: the
 * native capture obtains SO_PEERCRED and SO_PEERPIDFD from the same accepted
 * AF_UNIX socket before request framing yields control.
 */
export class NativeLinuxUnixPeerCredentialProvider
  implements LinuxUnixPeerCredentialProvider
{
  readonly binding: LinuxPeerCredentialNativeBinding;

  constructor(
    binding: LinuxPeerCredentialNativeBinding = loadLinuxInstallerNativeBinding() as LinuxPeerCredentialNativeBinding,
  ) {
    this.binding = binding;
  }

  inspect(socket: Socket): KernelUnixPeerCredentials {
    const native = this.binding.capture(acceptedSocketDescriptor(socket));
    if (
      !Number.isSafeInteger(native.pid) ||
      native.pid <= 0 ||
      !Number.isSafeInteger(native.uid) ||
      native.uid < 0 ||
      !Number.isSafeInteger(native.gid) ||
      native.gid < 0 ||
      typeof native.isAlive !== "function" ||
      typeof native.close !== "function"
    ) {
      try {
        native.close?.();
      } catch {
        // The malformed binding is already fatal; do not replace that error.
      }
      throw new Error("Native installer peer credentials are malformed.");
    }
    return {
      uid: native.uid,
      gid: native.gid,
      process: new NativePidfdProcessHandle(native),
    };
  }
}
