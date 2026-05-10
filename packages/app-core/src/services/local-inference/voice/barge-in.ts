export interface BargeInListener {
  onCancel(): void;
}

export interface CancelSignal {
  cancelled: boolean;
}

export class BargeInController {
  private readonly listeners = new Set<BargeInListener>();
  private signal: CancelSignal = { cancelled: false };

  cancelSignal(): CancelSignal {
    return this.signal;
  }

  attach(listener: BargeInListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onMicActive(): void {
    this.signal.cancelled = true;
    for (const l of this.listeners) {
      l.onCancel();
    }
  }

  reset(): void {
    this.signal = { cancelled: false };
  }
}
