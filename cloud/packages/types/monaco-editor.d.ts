declare module "monaco-editor" {
  export namespace editor {
    interface IStandaloneCodeEditor {
      getValue(): string;
      setValue(value: string): void;
      getModel(): unknown;
      dispose(): void;
      focus(): void;
      getDomNode(): HTMLElement | null;
      onDidChangeModelContent(listener: (e: unknown) => void): {
        dispose(): void;
      };
      layout(dimension?: { width: number; height: number }): void;
      updateOptions(options: Record<string, unknown>): void;
    }
  }
}
