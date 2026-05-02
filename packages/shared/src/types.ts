export interface StylePreset {
  id: string;
  name: string;
  avatarIndex: number;
  voicePresetId?: string;
  greetingAnimation?: string;
  catchphrase: string;
  hint: string;
  bio: string[];
  system: string;
  adjectives: string[];
  style: {
    all: string[];
    chat: string[];
    post: string[];
  };
  topics?: string[];
  postExamples: string[];
  postExamples_zhCN?: string[];
  messageExamples: Array<
    Array<{
      user: string;
      content: { text: string };
    }>
  >;
}
