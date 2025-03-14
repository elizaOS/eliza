---
sidebar_position: 11
---

# 🔐 Secrets Management

A comprehensive guide for managing secrets, API keys, and sensitive configuration in Eliza.

## Core Concepts

### Environment Variables

Eliza uses a hierarchical environment variable system:

1. Character-specific namespaced environment variables (highest priority)
2. Character-specific secrets
3. Environment variables
4. Default values (lowest priority)

### Secret Types

Common secrets you'll need to manage:

```bash
# API Keys
OPENAI_API_KEY=sk-*
ANTHROPIC_API_KEY=your-key
ELEVENLABS_XI_API_KEY=your-key
GOOGLE_GENERATIVE_AI_API_KEY=your-key

# Client Authentication
DISCORD_API_TOKEN=your-token
TELEGRAM_BOT_TOKEN=your-token

# Database Credentials
SUPABASE_URL=your-url
SUPABASE_SERVICE_API_KEY=your-key

# EVM
EVM_PRIVATE_KEY=EXAMPLE_WALLET_PRIVATE_KEY

# Solana
SOLANA_PRIVATE_KEY=EXAMPLE_WALLET_PRIVATE_KEY
SOLANA_PUBLIC_KEY=EXAMPLE_WALLET_PUBLIC_KEY

# Fallback Wallet Configuration (deprecated)
WALLET_PRIVATE_KEY=EXAMPLE_WALLET_PRIVATE_KEY
WALLET_PUBLIC_KEY=EXAMPLE_WALLET_PUBLIC_KEY
```

## Implementation Guide

### Basic Setup

1. Create a `.env` file from template:

```bash
cp .env.example .env
```

2. Configure environment discovery:

```typescript
import { config } from "dotenv";
import path from "path";

export function findNearestEnvFile(startDir = process.cwd()) {
    let currentDir = startDir;

    while (currentDir !== path.parse(currentDir).root) {
        const envPath = path.join(currentDir, ".env");

        if (fs.existsSync(envPath)) {
            return envPath;
        }

        currentDir = path.dirname(currentDir);
    }

    return null;
}
```

### Character-Specific Secrets

Define secrets in character files:

```json
{
    "name": "TradingBot",
    "settings": {
        "secrets": {
            "OPENAI_API_KEY": "character-specific-key",
            "WALLET_PRIVATE_KEY": "character-specific-wallet"
        }
    }
}
```

Alternatively, you can use the `CHARACTER.YOUR_CHARACTER_NAME.SECRET_NAME` format inside your `.env` file.

Access secrets in code:

```typescript
const apiKey = runtime.getSetting("OPENAI_API_KEY");
```

### Secure Storage

#### Database Secrets

Use encrypted connection strings:

```typescript
class SecureDatabase {
    private connection: Connection;

    constructor(encryptedConfig: string) {
        const config = this.decryptConfig(encryptedConfig);
        this.connection = new Connection(config);
    }

    private decryptConfig(encrypted: string): DatabaseConfig {
        // Implement decryption logic
        return JSON.parse(decrypted);
    }
}
```

#### Wallet Management

Secure handling of blockchain credentials:

```typescript
class WalletManager {
    private async initializeWallet(runtime: IAgentRuntime) {
        const privateKey =
            runtime.getSetting("SOLANA_PRIVATE_KEY") ??
            runtime.getSetting("WALLET_PRIVATE_KEY");

        if (!privateKey) {
            throw new Error("Wallet private key not configured");
        }

        // Validate key format
        try {
            const keyBuffer = Buffer.from(privateKey, "base64");
            if (keyBuffer.length !== 64) {
                throw new Error("Invalid key length");
            }
        } catch (error) {
            throw new Error("Invalid private key format");
        }

        // Initialize wallet securely
        return new Wallet(privateKey);
    }
}
```

### Secret Rotation

Implement automatic secret rotation:

```typescript
class SecretRotation {
    private static readonly SECRET_LIFETIME = 90 * 24 * 60 * 60 * 1000; // 90 days

    async shouldRotateSecret(secretName: string): Promise<boolean> {
        const lastRotation = await this.getLastRotation(secretName);
        return Date.now() - lastRotation > SecretRotation.SECRET_LIFETIME;
    }

    async rotateSecret(secretName: string): Promise<void> {
        // Implement rotation logic
        const newSecret = await this.generateNewSecret();
        await this.updateSecret(secretName, newSecret);
        await this.recordRotation(secretName);
    }
}
```

### Access Control

Implement proper access controls:

```typescript
class SecretAccess {
    private static readonly ALLOWED_KEYS = [
        "OPENAI_API_KEY",
        "DISCORD_TOKEN",
        // ... other allowed keys
    ];

    static validateAccess(key: string): boolean {
        return this.ALLOWED_KEYS.includes(key);
    }

    static async getSecret(
        runtime: IAgentRuntime,
        key: string,
    ): Promise<string | null> {
        if (!this.validateAccess(key)) {
            throw new Error(`Unauthorized access to secret: ${key}`);
        }

        return runtime.getSetting(key);
    }
}
```

### Encryption at Rest

Implement encryption for stored secrets:

```typescript
import { createCipheriv, createDecipheriv } from "crypto";

class SecretEncryption {
    static async encrypt(value: string, key: Buffer): Promise<string> {
        const iv = crypto.randomBytes(16);
        const cipher = createCipheriv("aes-256-gcm", key, iv);

        let encrypted = cipher.update(value, "utf8", "hex");
        encrypted += cipher.final("hex");

        return JSON.stringify({
            iv: iv.toString("hex"),
            encrypted,
            tag: cipher.getAuthTag().toString("hex"),
        });
    }

    static async decrypt(encrypted: string, key: Buffer): Promise<string> {
        const { iv, encrypted: encryptedData, tag } = JSON.parse(encrypted);

        const decipher = createDecipheriv(
            "aes-256-gcm",
            key,
            Buffer.from(iv, "hex"),
        );

        decipher.setAuthTag(Buffer.from(tag, "hex"));

        let decrypted = decipher.update(encryptedData, "hex", "utf8");
        decrypted += decipher.final("utf8");

        return decrypted;
    }
}
```

## Best Practices

### 1. Environment Segregation

Maintain separate environment files:

```bash
.env.development    # Local development settings
.env.staging       # Staging environment
.env.production    # Production settings
```

### 2. Git Security

Exclude sensitive files:

```gitignore
# .gitignore
.env
.env.*
characters/**/secrets.json
**/serviceAccount.json
```

### 3. Secret Validation

Validate secrets before use:

```typescript
async function validateSecrets(character: Character): Promise<void> {
    const required = ["OPENAI_API_KEY"];
    const missing = required.filter((key) => !character.settings.secrets[key]);

    if (missing.length > 0) {
        throw new Error(`Missing required secrets: ${missing.join(", ")}`);
    }
}
```

### 4. Error Handling

Secure error messages:

```typescript
try {
    await loadSecrets();
} catch (error) {
    if (error.code === "ENOENT") {
        console.error("Environment file not found");
    } else if (error instanceof ValidationError) {
        console.error("Invalid secret format");
    } else {
        // Log securely without exposing secret values
        console.error("Error loading secrets");
    }
}
```

## Security Considerations

### 1. Handling API Keys

```typescript
class APIKeyManager {
    private validateAPIKey(key: string): boolean {
        if (key.startsWith("sk-")) {
            return key.length > 20;
        }
        return false;
    }

    async rotateAPIKey(provider: string): Promise<void> {
        // Implement key rotation logic
    }
}
```

### 2. Secure Configuration Loading

```typescript
class ConfigLoader {
    private static sanitizePath(path: string): boolean {
        return !path.includes("../") && !path.startsWith("/");
    }

    async loadConfig(path: string): Promise<Config> {
        if (!this.sanitizePath(path)) {
            throw new Error("Invalid config path");
        }
        // Load configuration
    }
}
```

### 3. Memory Security

```typescript
class SecureMemory {
    private secrets: Map<string, WeakRef<string>> = new Map();

    set(key: string, value: string): void {
        this.secrets.set(key, new WeakRef(value));
    }

    get(key: string): string | null {
        const ref = this.secrets.get(key);
        return ref?.deref() ?? null;
    }
}
```

## Troubleshooting

### Common Issues

1. Missing Secrets

```typescript
if (!process.env.OPENAI_API_KEY) {
    throw new Error(
        "OpenAI API key not found in environment or character settings",
    );
}
```

2. Invalid Secret Format

```typescript
function validateApiKey(key: string): boolean {
    // OpenAI keys start with 'sk-'
    if (key.startsWith("sk-")) {
        return key.length > 20;
    }
    return false;
}
```

3. Secret Loading Errors

```typescript
try {
    await loadSecrets();
} catch (error) {
    if (error.response) {
        console.error("Response data:", error.response.data);
        console.error("Response status:", error.response.status);
    } else if (error.request) {
        console.error("No response received:", error.request);
    } else {
        console.error("Error setting up request:", error.message);
    }
}
```

## Related Resources

- [Configuration Guide](./configuration.md) for general setup
- [Local Development](./local-development.md) for development environment
- [Infrastructure Guide](../advanced/infrastructure.md) for deployment security
