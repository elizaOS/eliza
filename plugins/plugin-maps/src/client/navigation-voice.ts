/** Latest valid foreground instruction owns speech; new fixes do not repeat an unchanged step. */
export class NavigationVoice {
  enabled = true;
  private current?: { key: string; text: string };
  private spoken?: string;
  private owner?: AbortController;
  constructor(
    private failed: () => void,
    private speak: (text: string, signal: AbortSignal) => Promise<unknown>,
  ) {}
  update(key: string, text: string) {
    this.current = { key, text };
    if (!this.enabled || this.spoken === key) return;
    this.owner?.abort();
    const owner = new AbortController();
    this.owner = owner;
    this.spoken = key;
    void this.speak(text, owner.signal)
      .catch(() => {
        if (this.owner === owner && !owner.signal.aborted) {
          this.enabled = false;
          this.spoken = undefined;
          this.failed();
        }
      })
      .finally(() => {
        if (this.owner === owner) this.owner = undefined;
      });
  }
  pause() {
    this.owner?.abort();
    this.owner = undefined;
    this.current = undefined;
    this.spoken = undefined;
  }
  toggle() {
    this.enabled = !this.enabled;
    if (!this.enabled) {
      this.owner?.abort();
      this.owner = undefined;
      this.spoken = undefined;
    } else if (this.current) this.update(this.current.key, this.current.text);
  }
}
