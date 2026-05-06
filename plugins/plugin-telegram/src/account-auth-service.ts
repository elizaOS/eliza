import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Api, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';

export type TelegramAccountAuthStatus =
  | 'idle'
  | 'waiting_for_provisioning_code'
  | 'waiting_for_telegram_code'
  | 'waiting_for_password'
  | 'configured'
  | 'connected'
  | 'error';

export interface TelegramAccountAuthAccount {
  id: string;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
}

export interface TelegramAccountAuthSnapshot {
  status: TelegramAccountAuthStatus;
  phone: string | null;
  error: string | null;
  isCodeViaApp: boolean;
  account: TelegramAccountAuthAccount | null;
}

export interface TelegramAccountApiCredentials {
  apiId: number;
  apiHash: string;
}

export interface TelegramAccountConnectorConfig {
  phone: string;
  appId: string;
  appHash: string;
  deviceModel: string;
  systemVersion: string;
  enabled: true;
}

export interface TelegramAccountAuthSessionLike {
  start(options: {
    phone: string;
    credentials: TelegramAccountApiCredentials | null;
  }): Promise<TelegramAccountAuthSnapshot>;
  submit(input: {
    provisioningCode?: string;
    telegramCode?: string;
    password?: string;
  }): Promise<TelegramAccountAuthSnapshot>;
  stop(): Promise<void>;
  getSnapshot(): TelegramAccountAuthSnapshot;
  getResolvedConnectorConfig(): TelegramAccountConnectorConfig | null;
}

type TelegramAccountProvisioningApp = {
  api_id: number;
  api_hash: string;
};

type PersistedTelegramAccountAuthState = {
  snapshot: TelegramAccountAuthSnapshot;
  credentials: TelegramAccountApiCredentials | null;
  connectorConfig: TelegramAccountConnectorConfig | null;
  provisioningRandomHash: string | null;
  phoneCodeHash: string | null;
};

type TelegramAccountAuthDeps = {
  createTelegramClient?: (
    session: StringSession,
    credentials: TelegramAccountApiCredentials,
    deviceModel: string,
    systemVersion: string,
  ) => TelegramClient;
  sendProvisioningCode?: (phone: string) => Promise<string>;
  completeProvisioningLogin?: (
    phone: string,
    randomHash: string,
    code: string,
  ) => Promise<string>;
  getOrCreateProvisionedApp?: (
    stelToken: string,
  ) => Promise<TelegramAccountProvisioningApp>;
};

const MY_TELEGRAM_URL = 'https://my.telegram.org';
const TELEGRAM_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';
const TELEGRAM_ACCOUNT_AUTH_STATUSES = new Set<TelegramAccountAuthStatus>([
  'idle',
  'waiting_for_provisioning_code',
  'waiting_for_telegram_code',
  'waiting_for_password',
  'configured',
  'connected',
  'error',
]);

function resolveStateDir(): string {
  return (
    process.env.ELIZA_STATE_DIR?.trim() || path.join(os.homedir(), '.eliza')
  );
}

function resolveTelegramAccountSessionDir(): string {
  const sessionDir = path.join(resolveStateDir(), 'telegram-account');
  fs.mkdirSync(sessionDir, { recursive: true });
  return sessionDir;
}

export function resolveTelegramAccountSessionFile(): string {
  return path.join(resolveTelegramAccountSessionDir(), 'session.txt');
}

function resolveTelegramAccountAuthStateFile(): string {
  return path.join(resolveTelegramAccountSessionDir(), 'auth-state.json');
}

export function loadTelegramAccountSessionString(): string {
  const sessionFile = resolveTelegramAccountSessionFile();
  if (!fs.existsSync(sessionFile)) {
    return '';
  }
  return fs.readFileSync(sessionFile, 'utf8').trim();
}

export function saveTelegramAccountSessionString(session: string): void {
  fs.writeFileSync(resolveTelegramAccountSessionFile(), session, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

export function clearTelegramAccountSession(): void {
  fs.rmSync(resolveTelegramAccountSessionFile(), { force: true });
}

export function telegramAccountSessionExists(): boolean {
  const sessionFile = resolveTelegramAccountSessionFile();
  return fs.existsSync(sessionFile) && fs.statSync(sessionFile).size > 0;
}

function readTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readPersistedAccount(
  value: unknown,
): TelegramAccountAuthAccount | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = readTrimmedString(record.id);
  if (!id) {
    return null;
  }
  return {
    id,
    username: readTrimmedString(record.username),
    firstName: readTrimmedString(record.firstName),
    lastName: readTrimmedString(record.lastName),
    phone: readTrimmedString(record.phone),
  };
}

function readPersistedSnapshot(
  value: unknown,
): TelegramAccountAuthSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const status = record.status;
  if (
    typeof status !== 'string' ||
    !TELEGRAM_ACCOUNT_AUTH_STATUSES.has(status as TelegramAccountAuthStatus)
  ) {
    return null;
  }
  return {
    status: status as TelegramAccountAuthStatus,
    phone: readTrimmedString(record.phone),
    error:
      typeof record.error === 'string' && record.error.trim().length > 0
        ? record.error
        : null,
    isCodeViaApp: record.isCodeViaApp === true,
    account: readPersistedAccount(record.account),
  };
}

function readPersistedCredentials(
  value: unknown,
): TelegramAccountApiCredentials | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const apiIdValue = record.apiId;
  const apiId =
    typeof apiIdValue === 'number'
      ? apiIdValue
      : typeof apiIdValue === 'string' && apiIdValue.trim().length > 0
        ? Number.parseInt(apiIdValue, 10)
        : Number.NaN;
  const apiHash = readTrimmedString(record.apiHash);
  if (!Number.isInteger(apiId) || apiId <= 0 || !apiHash) {
    return null;
  }
  return { apiId, apiHash };
}

function readPersistedConnectorConfig(
  value: unknown,
): TelegramAccountConnectorConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const phone = readTrimmedString(record.phone);
  const appId = readTrimmedString(record.appId);
  const appHash = readTrimmedString(record.appHash);
  const deviceModel = readTrimmedString(record.deviceModel);
  const systemVersion = readTrimmedString(record.systemVersion);
  if (!phone || !appId || !appHash || !deviceModel || !systemVersion) {
    return null;
  }
  return {
    phone,
    appId,
    appHash,
    deviceModel,
    systemVersion,
    enabled: true,
  };
}

function loadTelegramAccountAuthState(): PersistedTelegramAccountAuthState | null {
  const authStateFile = resolveTelegramAccountAuthStateFile();
  if (!fs.existsSync(authStateFile)) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      fs.readFileSync(authStateFile, 'utf8'),
    ) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    const snapshot = readPersistedSnapshot(record.snapshot);
    if (!snapshot) {
      return null;
    }
    return {
      snapshot,
      credentials: readPersistedCredentials(record.credentials),
      connectorConfig: readPersistedConnectorConfig(record.connectorConfig),
      provisioningRandomHash: readTrimmedString(record.provisioningRandomHash),
      phoneCodeHash: readTrimmedString(record.phoneCodeHash),
    };
  } catch {
    return null;
  }
}

function saveTelegramAccountAuthState(
  state: PersistedTelegramAccountAuthState,
): void {
  fs.writeFileSync(
    resolveTelegramAccountAuthStateFile(),
    JSON.stringify(state),
    {
      encoding: 'utf8',
      mode: 0o600,
    },
  );
}

export function clearTelegramAccountAuthState(): void {
  fs.rmSync(resolveTelegramAccountAuthStateFile(), { force: true });
}

export function telegramAccountAuthStateExists(): boolean {
  const authStateFile = resolveTelegramAccountAuthStateFile();
  return fs.existsSync(authStateFile) && fs.statSync(authStateFile).size > 0;
}

export function defaultTelegramAccountDeviceModel(): string {
  return 'Eliza Desktop';
}

export function defaultTelegramAccountSystemVersion(): string {
  const platform = os.platform();
  const release = os.release();
  if (platform === 'darwin') {
    return `macOS ${release}`;
  }
  if (platform === 'win32') {
    return `Windows ${release}`;
  }
  return `${platform} ${release}`;
}

function mapTelegramAccount(user: Api.User): TelegramAccountAuthAccount {
  return {
    id: user.id.toString(),
    username: typeof user.username === 'string' ? user.username : null,
    firstName: typeof user.firstName === 'string' ? user.firstName : null,
    lastName: typeof user.lastName === 'string' ? user.lastName : null,
    phone: typeof user.phone === 'string' ? user.phone : null,
  };
}

function createTelegramClient(
  session: StringSession,
  credentials: TelegramAccountApiCredentials,
  deviceModel: string,
  systemVersion: string,
): TelegramClient {
  return new TelegramClient(session, credentials.apiId, credentials.apiHash, {
    connectionRetries: 5,
    deviceModel,
    systemVersion,
  });
}

interface SerializableTelegramSession {
  save(): unknown;
}

function isSerializableTelegramSession(
  session: unknown,
): session is SerializableTelegramSession {
  return (
    typeof session === 'object' &&
    session !== null &&
    typeof Reflect.get(session, 'save') === 'function'
  );
}

function serializeSession(client: TelegramClient): string {
  if (!isSerializableTelegramSession(client.session)) {
    throw new Error('Telegram client session cannot be serialized');
  }
  const savedSession = client.session.save();
  if (typeof savedSession !== 'string') {
    throw new Error('Telegram client session did not serialize to a string');
  }
  return savedSession;
}

function createAjaxHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'User-Agent': TELEGRAM_USER_AGENT,
    Origin: MY_TELEGRAM_URL,
    'X-Requested-With': 'XMLHttpRequest',
  };
}

function createFormHeaders(cookie?: string): Record<string, string> {
  return {
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'User-Agent': TELEGRAM_USER_AGENT,
    ...(cookie ? { Cookie: cookie } : {}),
  };
}

function extractRandomHash(data: unknown): string | null {
  if (!data || typeof data !== 'object') {
    return null;
  }
  const randomHash = (data as { random_hash?: unknown }).random_hash;
  return typeof randomHash === 'string' && randomHash.trim().length > 0
    ? randomHash.trim()
    : null;
}

function getSetCookieHeaders(headers: Headers): string[] {
  const withGetSetCookie = headers as Headers & {
    getSetCookie?: () => string[];
  };
  if (typeof withGetSetCookie.getSetCookie === 'function') {
    return withGetSetCookie.getSetCookie();
  }
  const single = headers.get('set-cookie');
  return single ? [single] : [];
}

function extractCookieValue(
  headers: Headers,
  cookieName: string,
): string | null {
  const pattern = new RegExp(`(?:^|;\\s*)${cookieName}=([^;]+)`);
  for (const header of getSetCookieHeaders(headers)) {
    const match = header.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }
  return null;
}

function extractProvisionedApp(html: string): TelegramAccountProvisioningApp {
  const apiIdMatch = html.match(
    /<span class="form-control input-xlarge uneditable-input"[^>]*><strong>(\d+)<\/strong><\/span>/,
  );
  const apiHashMatch = html.match(
    /<span class="form-control input-xlarge uneditable-input"[^>]*>([a-f0-9]{32})<\/span>/i,
  );
  if (!apiIdMatch?.[1] || !apiHashMatch?.[1]) {
    throw new Error('Failed to parse Telegram app credentials');
  }
  return {
    api_id: Number(apiIdMatch[1]),
    api_hash: apiHashMatch[1],
  };
}

function extractCreationHash(html: string): string | null {
  const match = html.match(/<input[^>]*name="hash"[^>]*value="([^"]+)"/i);
  return match?.[1] ?? null;
}

async function sendProvisioningCode(phone: string): Promise<string> {
  const response = await fetch(`${MY_TELEGRAM_URL}/auth/send_password`, {
    method: 'POST',
    headers: createAjaxHeaders(),
    body: new URLSearchParams({ phone }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  if (text.includes('Sorry, too many tries')) {
    throw new Error('Telegram provisioning is rate limited right now');
  }
  const parsed = JSON.parse(text) as unknown;
  const randomHash = extractRandomHash(parsed);
  if (!randomHash) {
    throw new Error('Telegram provisioning did not return a login token');
  }
  return randomHash;
}

async function completeProvisioningLogin(
  phone: string,
  randomHash: string,
  code: string,
): Promise<string> {
  const response = await fetch(`${MY_TELEGRAM_URL}/auth/login`, {
    method: 'POST',
    headers: createAjaxHeaders(),
    body: new URLSearchParams({
      phone,
      random_hash: randomHash,
      password: code,
    }),
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  if (text === 'Invalid confirmation code!') {
    throw new Error('Invalid Telegram provisioning code');
  }
  if (text !== 'true') {
    throw new Error('Telegram provisioning login failed');
  }
  const stelToken = extractCookieValue(response.headers, 'stel_token');
  if (!stelToken) {
    throw new Error('Telegram provisioning did not return a session token');
  }
  return stelToken;
}

async function getOrCreateProvisionedApp(
  stelToken: string,
): Promise<TelegramAccountProvisioningApp> {
  const cookie = `stel_token=${stelToken}`;
  const response = await fetch(`${MY_TELEGRAM_URL}/apps`, {
    headers: {
      Cookie: cookie,
      'User-Agent': TELEGRAM_USER_AGENT,
    },
    signal: AbortSignal.timeout(15_000),
  });
  const html = await response.text();
  if (/<title>\s*App configuration\s*<\/title>/i.test(html)) {
    return extractProvisionedApp(html);
  }
  if (!/<title>\s*Create new application\s*<\/title>/i.test(html)) {
    throw new Error('Telegram app provisioning page could not be parsed');
  }
  const creationHash = extractCreationHash(html);
  if (!creationHash) {
    throw new Error('Telegram app provisioning hash missing');
  }
  const createResponse = await fetch(`${MY_TELEGRAM_URL}/apps/create`, {
    method: 'POST',
    headers: createFormHeaders(cookie),
    body: new URLSearchParams({
      hash: creationHash,
      app_title: 'eliza',
      app_shortname: 'eliza',
      app_platform: 'other',
      app_url: '',
      app_desc: '',
    }),
    signal: AbortSignal.timeout(15_000),
  });
  return extractProvisionedApp(await createResponse.text());
}

export class TelegramAccountAuthSession implements TelegramAccountAuthSessionLike {
  private snapshot: TelegramAccountAuthSnapshot = {
    status: 'idle',
    phone: null,
    error: null,
    isCodeViaApp: false,
    account: null,
  };
  private client: TelegramClient | null = null;
  private credentials: TelegramAccountApiCredentials | null = null;
  private connectorConfig: TelegramAccountConnectorConfig | null = null;
  private provisioningRandomHash: string | null = null;
  private phoneCodeHash: string | null = null;
  private readonly deviceModel: string;
  private readonly systemVersion: string;
  private readonly deps: Required<TelegramAccountAuthDeps>;

  constructor(
    options: {
      deviceModel?: string;
      systemVersion?: string;
    } = {},
    deps: TelegramAccountAuthDeps = {},
  ) {
    this.deviceModel =
      options.deviceModel?.trim() || defaultTelegramAccountDeviceModel();
    this.systemVersion =
      options.systemVersion?.trim() || defaultTelegramAccountSystemVersion();
    this.deps = {
      createTelegramClient: deps.createTelegramClient ?? createTelegramClient,
      sendProvisioningCode: deps.sendProvisioningCode ?? sendProvisioningCode,
      completeProvisioningLogin:
        deps.completeProvisioningLogin ?? completeProvisioningLogin,
      getOrCreateProvisionedApp:
        deps.getOrCreateProvisionedApp ?? getOrCreateProvisionedApp,
    };

    const persisted = loadTelegramAccountAuthState();
    if (persisted) {
      this.snapshot = persisted.snapshot;
      this.credentials = persisted.credentials;
      this.connectorConfig = persisted.connectorConfig;
      this.provisioningRandomHash = persisted.provisioningRandomHash;
      this.phoneCodeHash = persisted.phoneCodeHash;
    }
  }

  getSnapshot(): TelegramAccountAuthSnapshot {
    return { ...this.snapshot };
  }

  getResolvedConnectorConfig(): TelegramAccountConnectorConfig | null {
    return this.connectorConfig ? { ...this.connectorConfig } : null;
  }

  async start(options: {
    phone: string;
    credentials: TelegramAccountApiCredentials | null;
  }): Promise<TelegramAccountAuthSnapshot> {
    const phone = options.phone.trim();
    if (!phone) {
      throw new Error('Telegram phone number is required');
    }

    await this.disconnectClient();
    clearTelegramAccountSession();
    clearTelegramAccountAuthState();
    this.snapshot = {
      status: 'idle',
      phone,
      error: null,
      isCodeViaApp: false,
      account: null,
    };
    this.credentials = options.credentials;
    this.connectorConfig = null;

    if (this.credentials) {
      await this.beginTelegramLogin();
      return this.getSnapshot();
    }

    this.provisioningRandomHash = await this.deps.sendProvisioningCode(phone);
    this.snapshot.status = 'waiting_for_provisioning_code';
    this.persistAuthState();
    return this.getSnapshot();
  }

  async submit(input: {
    provisioningCode?: string;
    telegramCode?: string;
    password?: string;
  }): Promise<TelegramAccountAuthSnapshot> {
    switch (this.snapshot.status) {
      case 'waiting_for_provisioning_code': {
        const provisioningCode = input.provisioningCode?.trim();
        if (!provisioningCode) {
          throw new Error('Telegram provisioning code is required');
        }
        if (!this.snapshot.phone || !this.provisioningRandomHash) {
          throw new Error('Telegram provisioning session is missing state');
        }
        const stelToken = await this.deps.completeProvisioningLogin(
          this.snapshot.phone,
          this.provisioningRandomHash,
          provisioningCode,
        );
        const app = await this.deps.getOrCreateProvisionedApp(stelToken);
        this.credentials = {
          apiId: app.api_id,
          apiHash: app.api_hash,
        };
        this.provisioningRandomHash = null;
        await this.beginTelegramLogin();
        return this.getSnapshot();
      }
      case 'waiting_for_telegram_code': {
        const telegramCode = input.telegramCode?.trim();
        if (!telegramCode) {
          throw new Error('Telegram login code is required');
        }
        await this.ensureClientConnected();
        await this.completeTelegramCode(telegramCode);
        return this.getSnapshot();
      }
      case 'waiting_for_password': {
        const password = input.password ?? '';
        if (!password.trim()) {
          throw new Error('Telegram two-factor password is required');
        }
        await this.ensureClientConnected();
        await this.completePassword(password);
        return this.getSnapshot();
      }
      default:
        throw new Error('Telegram login is not waiting for input');
    }
  }

  async stop(): Promise<void> {
    await this.disconnectClient();
    this.provisioningRandomHash = null;
    this.phoneCodeHash = null;
    this.credentials = null;
    this.connectorConfig = null;
    this.snapshot = {
      status: 'idle',
      phone: null,
      error: null,
      isCodeViaApp: false,
      account: null,
    };
    clearTelegramAccountAuthState();
  }

  private async beginTelegramLogin(): Promise<void> {
    if (!this.credentials || !this.snapshot.phone) {
      throw new Error('Telegram login credentials are incomplete');
    }

    const session = new StringSession(loadTelegramAccountSessionString());
    this.client = this.deps.createTelegramClient(
      session,
      this.credentials,
      this.deviceModel,
      this.systemVersion,
    );
    await this.client.connect();
    this.persistSession();

    if (await this.client.checkAuthorization()) {
      const me = (await this.client.getEntity('me')) as Api.User;
      await this.finishAuthorized(me);
      return;
    }

    const sentCode = await this.client.sendCode(
      this.credentials,
      this.snapshot.phone,
    );
    this.phoneCodeHash = sentCode.phoneCodeHash;
    this.snapshot.status = 'waiting_for_telegram_code';
    this.snapshot.isCodeViaApp = sentCode.isCodeViaApp;
    this.snapshot.error = null;
    this.persistSession();
    this.persistAuthState();
  }

  private async completeTelegramCode(code: string): Promise<void> {
    if (
      !this.client ||
      !this.credentials ||
      !this.snapshot.phone ||
      !this.phoneCodeHash
    ) {
      throw new Error('Telegram login session is missing state');
    }
    try {
      const result = await this.client.invoke(
        new Api.auth.SignIn({
          phoneNumber: this.snapshot.phone,
          phoneCodeHash: this.phoneCodeHash,
          phoneCode: code,
        }),
      );
      if (!(result instanceof Api.auth.Authorization)) {
        throw new Error('Telegram returned an unexpected authorization state');
      }
      await this.finishAuthorized(result.user as Api.User);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('SESSION_PASSWORD_NEEDED')) {
        this.snapshot.status = 'waiting_for_password';
        this.snapshot.error = null;
        this.persistSession();
        this.persistAuthState();
        return;
      }
      this.snapshot.status = 'error';
      this.snapshot.error = message;
      this.persistAuthState();
      throw error;
    }
  }

  private async completePassword(password: string): Promise<void> {
    if (!this.client || !this.credentials) {
      throw new Error('Telegram password login session is missing state');
    }
    try {
      const user = (await this.client.signInWithPassword(this.credentials, {
        password: async () => password,
        onError: (error: unknown) => {
          throw error instanceof Error ? error : new Error(String(error));
        },
      })) as Api.User;
      await this.finishAuthorized(user);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.snapshot.status = 'error';
      this.snapshot.error = message;
      this.persistAuthState();
      throw error;
    }
  }

  private async finishAuthorized(user: Api.User): Promise<void> {
    if (!this.snapshot.phone || !this.credentials || !this.client) {
      throw new Error('Telegram authorization finished without session state');
    }
    saveTelegramAccountSessionString(serializeSession(this.client));
    this.connectorConfig = {
      phone: this.snapshot.phone,
      appId: String(this.credentials.apiId),
      appHash: this.credentials.apiHash,
      deviceModel: this.deviceModel,
      systemVersion: this.systemVersion,
      enabled: true,
    };
    this.snapshot = {
      status: 'configured',
      phone: this.snapshot.phone,
      error: null,
      isCodeViaApp: false,
      account: mapTelegramAccount(user),
    };
    clearTelegramAccountAuthState();
    await this.disconnectClient();
  }

  private persistSession(): void {
    if (!this.client) {
      return;
    }
    const session = serializeSession(this.client);
    if (session.trim().length > 0) {
      saveTelegramAccountSessionString(session);
    }
  }

  private persistAuthState(): void {
    saveTelegramAccountAuthState({
      snapshot: this.snapshot,
      credentials: this.credentials,
      connectorConfig: this.connectorConfig,
      provisioningRandomHash: this.provisioningRandomHash,
      phoneCodeHash: this.phoneCodeHash,
    });
  }

  private async disconnectClient(): Promise<void> {
    if (!this.client) {
      return;
    }
    this.persistSession();
    await this.client.disconnect().catch(() => undefined);
    this.client = null;
  }

  private async ensureClientConnected(): Promise<void> {
    if (this.client) {
      return;
    }
    if (!this.credentials) {
      throw new Error('Telegram login session is missing credentials');
    }
    const sessionString = loadTelegramAccountSessionString();
    if (!sessionString.trim()) {
      throw new Error(
        'Telegram login session is missing persisted session data',
      );
    }
    this.client = this.deps.createTelegramClient(
      new StringSession(sessionString),
      this.credentials,
      this.deviceModel,
      this.systemVersion,
    );
    await this.client.connect();
  }
}
