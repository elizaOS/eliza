export type DeviceType = "ipad" | "mac";
export type LoginStatus = "waiting" | "need_verify" | "logged_in";

export interface WechatAccountConfig {
  enabled?: boolean;
  name?: string;
  apiKey: string;
  proxyUrl: string;
  deviceType?: DeviceType;
  webhookPort?: number;
  webhookUrl?: string;
  wcId?: string;
  nickName?: string;
}

export interface WechatConfig {
  enabled?: boolean;
  apiKey?: string;
  proxyUrl?: string;
  webhookPort?: number;
  deviceType?: DeviceType;
  loginTimeoutMs?: number;
  accounts?: Record<string, WechatAccountConfig>;
  features?: {
    images?: boolean;
    groups?: boolean;
  };
}

export interface ResolvedWechatAccount {
  id: string;
  apiKey: string;
  proxyUrl: string;
  deviceType: DeviceType;
  webhookPort: number;
  wcId?: string;
  nickName?: string;
}

export type WechatMessageType =
  | "text"
  | "image"
  | "video"
  | "file"
  | "voice"
  | "unknown";

export interface WechatMessageContext {
  id: string;
  type: WechatMessageType;
  sender: string;
  recipient: string;
  content: string;
  timestamp: number;
  threadId?: string;
  group?: {
    subject: string;
  };
  imageUrl?: string;
  raw: unknown;
}

export interface AccountStatus {
  valid: boolean;
  wcId?: string;
  loginState: LoginStatus;
  nickName?: string;
  tier?: string;
  quota?: number;
}

export interface ProxyApiResponse<T> {
  code: number;
  message?: string;
  data?: T;
}
