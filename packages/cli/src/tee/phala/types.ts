import { z } from "zod"

const dockerConfigSchema = z.object({
    password: z.string(),
    registry: z.string().nullable(),
    username: z.string()
})

const composeFileSchema = z.object({
    docker_compose_file: z.string(),
    docker_config: dockerConfigSchema,
    features: z.array(z.string()),
    kms_enabled: z.boolean(),
    manifest_version: z.number(),
    name: z.string(),
    public_logs: z.boolean(),
    public_sysinfo: z.boolean(),
    runner: z.string(),
    salt: z.string().nullable(),
    tproxy_enabled: z.boolean(),
    version: z.string()
})

const configurationSchema = z.object({
    name: z.string(),
    image: z.string(),
    compose_file: composeFileSchema,
    vcpu: z.number(),
    memory: z.number(),
    disk_size: z.number(),
    ports: z.array(z.any())
})

const hostedSchema = z.object({
    id: z.string(),
    name: z.string(),
    status: z.string(),
    uptime: z.string(),
    app_url: z.string(),
    app_id: z.string(),
    instance_id: z.string(),
    configuration: configurationSchema,
    exited_at: z.string(),
    boot_progress: z.string(),
    boot_error: z.string(),
    shutdown_progress: z.string(),
    image_version: z.string()
})

const managedUserSchema = z.object({
    id: z.number(),
    username: z.string()
})

const nodeSchema = z.object({
    id: z.number(),
    name: z.string()
})

const cvmInstanceSchema = z.object({
    hosted: hostedSchema,
    name: z.string(),
    managed_user: managedUserSchema,
    node: nodeSchema,
    listed: z.boolean(),
    status: z.string(),
    in_progress: z.boolean(),
    dapp_dashboard_url: z.string(),
    syslog_endpoint: z.string(),
    allow_upgrade: z.boolean()
})

const createCvmResponseSchema = z.object({
    app_id: z.string(),
    app_url: z.string()
})

const getPubkeyFromCvmResponseSchema = z.object({
    app_env_encrypt_pubkey: z.string(),
    app_id_salt: z.string()
})

const getCvmByAppIdResponseSchema = z.object({
    id: z.string(),
    name: z.string(),
    app_id: z.string(),
    app_url: z.string(),
    encrypted_env_pubkey: z.string(),
    status: z.string()
})

const getUserInfoResponseSchema = z.object({
    id: z.string(),
    username: z.string()
})

const getCvmsByUserIdResponseSchema = z.array(cvmInstanceSchema)

const upgradeCvmResponseSchema = z.object({
    detail: z.string()
})

const encryptedEnvItemSchema = z.object({
    key: z.string(),
    value: z.string()
})

// Type exports
export type DockerConfig = z.infer<typeof dockerConfigSchema>
export type ComposeFile = z.infer<typeof composeFileSchema>
export type Configuration = z.infer<typeof configurationSchema>
export type Hosted = z.infer<typeof hostedSchema>
export type ManagedUser = z.infer<typeof managedUserSchema>
export type Node = z.infer<typeof nodeSchema>
export type CvmInstance = z.infer<typeof cvmInstanceSchema>
export type CreateCvmResponse = z.infer<typeof createCvmResponseSchema>
export type GetPubkeyFromCvmResponse = z.infer<typeof getPubkeyFromCvmResponseSchema>
export type GetCvmByAppIdResponse = z.infer<typeof getCvmByAppIdResponseSchema>
export type GetUserInfoResponse = z.infer<typeof getUserInfoResponseSchema>
export type GetCvmsByUserIdResponse = z.infer<typeof getCvmsByUserIdResponseSchema>
export type UpgradeCvmResponse = z.infer<typeof upgradeCvmResponseSchema>
export type EncryptedEnvItem = z.infer<typeof encryptedEnvItemSchema>

// Schema exports
export const schemas = {
    dockerConfig: dockerConfigSchema,
    composeFile: composeFileSchema,
    configuration: configurationSchema,
    hosted: hostedSchema,
    managedUser: managedUserSchema,
    node: nodeSchema,
    cvmInstance: cvmInstanceSchema,
    createCvmResponse: createCvmResponseSchema,
    getPubkeyFromCvmResponse: getPubkeyFromCvmResponseSchema,
    getCvmByAppIdResponse: getCvmByAppIdResponseSchema,
    getUserInfoResponse: getUserInfoResponseSchema,
    getCvmsByUserIdResponse: getCvmsByUserIdResponseSchema,
    upgradeCvmResponse: upgradeCvmResponseSchema,
    encryptedEnvItem: encryptedEnvItemSchema
} as const