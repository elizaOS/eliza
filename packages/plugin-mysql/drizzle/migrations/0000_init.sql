CREATE TABLE `agents` (
	`id` varchar(36) NOT NULL DEFAULT (UUID()),
	`enabled` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`name` varchar(255),
	`username` varchar(255),
	`system` text,
	`bio` json NOT NULL,
	`message_examples` json DEFAULT ('[]'),
	`post_examples` json DEFAULT ('[]'),
	`topics` json DEFAULT ('[]'),
	`adjectives` json DEFAULT ('[]'),
	`knowledge` json DEFAULT ('[]'),
	`plugins` json DEFAULT ('[]'),
	`settings` json DEFAULT ('{}'),
	`style` json DEFAULT ('{}'),
	CONSTRAINT `agents_id` PRIMARY KEY(`id`),
	CONSTRAINT `name_unique` UNIQUE(`name`)
);
--> statement-breakpoint
CREATE TABLE `cache` (
	`id` varchar(36) NOT NULL DEFAULT (UUID()),
	`key` varchar(255) NOT NULL,
	`agentId` varchar(36) NOT NULL,
	`value` json NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`expiresAt` timestamp,
	CONSTRAINT `cache_id` PRIMARY KEY(`id`),
	CONSTRAINT `cache_key_agent_unique` UNIQUE(`key`,`agentId`)
);
--> statement-breakpoint
CREATE TABLE `components` (
	`id` varchar(36) NOT NULL DEFAULT (UUID()),
	`entityId` varchar(36) NOT NULL,
	`agentId` varchar(36) NOT NULL,
	`roomId` varchar(36) NOT NULL,
	`worldId` varchar(36),
	`sourceEntityId` varchar(36),
	`type` varchar(50) NOT NULL,
	`data` json DEFAULT ('{}'),
	`createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `components_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `embeddings` (
	`id` varchar(36) NOT NULL DEFAULT (UUID()),
	`memory_id` varchar(36),
	`created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`dim_384` vector(384),
	`dim_512` vector(512),
	`dim_768` vector(768),
	`dim_1024` vector(1024),
	`dim_1536` vector(1536),
	`dim_3072` vector(3072),
	CONSTRAINT `embeddings_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `entities` (
	`id` varchar(36) NOT NULL,
	`agentId` varchar(36) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`names` json DEFAULT ('[]'),
	`metadata` json DEFAULT ('{}'),
	CONSTRAINT `entities_id` PRIMARY KEY(`id`),
	CONSTRAINT `id_agent_id_unique` UNIQUE(`id`,`agentId`)
);
--> statement-breakpoint
CREATE TABLE `logs` (
	`id` varchar(36) NOT NULL DEFAULT (UUID()),
	`createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`entityId` varchar(36) NOT NULL,
	`body` json NOT NULL,
	`type` varchar(50) NOT NULL,
	`roomId` varchar(36) NOT NULL,
	CONSTRAINT `logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `memories` (
	`id` varchar(36) NOT NULL,
	`type` varchar(50) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`content` json NOT NULL,
	`entityId` varchar(36),
	`agentId` varchar(36),
	`roomId` varchar(36),
	`unique` boolean NOT NULL DEFAULT true,
	`metadata` json NOT NULL DEFAULT ('{}'),
	CONSTRAINT `memories_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `participants` (
	`id` varchar(36) NOT NULL DEFAULT (UUID()),
	`createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`entityId` varchar(36),
	`roomId` varchar(36),
	`agentId` varchar(36),
	`roomState` text,
	CONSTRAINT `participants_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `relationships` (
	`id` varchar(36) NOT NULL DEFAULT (UUID()),
	`createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`sourceEntityId` varchar(36) NOT NULL,
	`targetEntityId` varchar(36) NOT NULL,
	`agentId` varchar(36) NOT NULL,
	`tags` json DEFAULT ('[]'),
	`metadata` json DEFAULT ('{}'),
	CONSTRAINT `relationships_id` PRIMARY KEY(`id`),
	CONSTRAINT `unique_relationship` UNIQUE(`sourceEntityId`,`targetEntityId`,`agentId`)
);
--> statement-breakpoint
CREATE TABLE `rooms` (
	`id` varchar(36) NOT NULL DEFAULT (UUID()),
	`agentId` varchar(36),
	`source` varchar(255) NOT NULL,
	`type` varchar(50) NOT NULL,
	`serverId` varchar(255),
	`worldId` varchar(36),
	`name` varchar(255),
	`metadata` json DEFAULT ('{}'),
	`channelId` varchar(255),
	`createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `rooms_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `worlds` (
	`id` varchar(36) NOT NULL DEFAULT (UUID()),
	`agentId` varchar(36) NOT NULL,
	`name` varchar(255) NOT NULL,
	`metadata` json DEFAULT ('{}'),
	`serverId` varchar(255) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `worlds_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` varchar(36) NOT NULL DEFAULT (UUID()),
	`name` varchar(255) NOT NULL,
	`description` varchar(1000) NOT NULL,
	`room_id` varchar(36),
	`world_id` varchar(36),
	`agent_id` varchar(36) NOT NULL,
	`tags` json DEFAULT ('[]'),
	`metadata` json DEFAULT ('{}'),
	`created_at` timestamp DEFAULT (now()),
	`updated_at` timestamp DEFAULT (now()),
	CONSTRAINT `tasks_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `cache` ADD CONSTRAINT `cache_agentId_agents_id_fk` FOREIGN KEY (`agentId`) REFERENCES `agents`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `components` ADD CONSTRAINT `components_entityId_entities_id_fk` FOREIGN KEY (`entityId`) REFERENCES `entities`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `components` ADD CONSTRAINT `components_agentId_agents_id_fk` FOREIGN KEY (`agentId`) REFERENCES `agents`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `components` ADD CONSTRAINT `components_roomId_rooms_id_fk` FOREIGN KEY (`roomId`) REFERENCES `rooms`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `components` ADD CONSTRAINT `components_worldId_worlds_id_fk` FOREIGN KEY (`worldId`) REFERENCES `worlds`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `components` ADD CONSTRAINT `components_sourceEntityId_entities_id_fk` FOREIGN KEY (`sourceEntityId`) REFERENCES `entities`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `embeddings` ADD CONSTRAINT `embeddings_memory_id_memories_id_fk` FOREIGN KEY (`memory_id`) REFERENCES `memories`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `embeddings` ADD CONSTRAINT `fk_embedding_memory` FOREIGN KEY (`memory_id`) REFERENCES `memories`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `entities` ADD CONSTRAINT `entities_agentId_agents_id_fk` FOREIGN KEY (`agentId`) REFERENCES `agents`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `logs` ADD CONSTRAINT `logs_entityId_entities_id_fk` FOREIGN KEY (`entityId`) REFERENCES `entities`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `logs` ADD CONSTRAINT `logs_roomId_rooms_id_fk` FOREIGN KEY (`roomId`) REFERENCES `rooms`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `logs` ADD CONSTRAINT `fk_log_room` FOREIGN KEY (`roomId`) REFERENCES `rooms`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `logs` ADD CONSTRAINT `fk_logs_entityId` FOREIGN KEY (`entityId`) REFERENCES `entities`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `memories` ADD CONSTRAINT `fk_room` FOREIGN KEY (`roomId`) REFERENCES `rooms`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `memories` ADD CONSTRAINT `fk_memories_entityId` FOREIGN KEY (`entityId`) REFERENCES `entities`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `memories` ADD CONSTRAINT `fk_agent` FOREIGN KEY (`agentId`) REFERENCES `agents`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `participants` ADD CONSTRAINT `participants_entityId_entities_id_fk` FOREIGN KEY (`entityId`) REFERENCES `entities`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `participants` ADD CONSTRAINT `participants_roomId_rooms_id_fk` FOREIGN KEY (`roomId`) REFERENCES `rooms`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `participants` ADD CONSTRAINT `participants_agentId_agents_id_fk` FOREIGN KEY (`agentId`) REFERENCES `agents`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `participants` ADD CONSTRAINT `fk_participant_room` FOREIGN KEY (`roomId`) REFERENCES `rooms`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `participants` ADD CONSTRAINT `fk_participants_entityId` FOREIGN KEY (`entityId`) REFERENCES `entities`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `relationships` ADD CONSTRAINT `relationships_sourceEntityId_entities_id_fk` FOREIGN KEY (`sourceEntityId`) REFERENCES `entities`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `relationships` ADD CONSTRAINT `relationships_targetEntityId_entities_id_fk` FOREIGN KEY (`targetEntityId`) REFERENCES `entities`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `relationships` ADD CONSTRAINT `relationships_agentId_agents_id_fk` FOREIGN KEY (`agentId`) REFERENCES `agents`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `relationships` ADD CONSTRAINT `fk_user_a` FOREIGN KEY (`sourceEntityId`) REFERENCES `entities`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `relationships` ADD CONSTRAINT `fk_user_b` FOREIGN KEY (`targetEntityId`) REFERENCES `entities`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `rooms` ADD CONSTRAINT `rooms_agentId_agents_id_fk` FOREIGN KEY (`agentId`) REFERENCES `agents`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `rooms` ADD CONSTRAINT `rooms_worldId_worlds_id_fk` FOREIGN KEY (`worldId`) REFERENCES `worlds`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `worlds` ADD CONSTRAINT `worlds_agentId_agents_id_fk` FOREIGN KEY (`agentId`) REFERENCES `agents`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_embedding_memory` ON `embeddings` (`memory_id`);--> statement-breakpoint
CREATE INDEX `idx_memories_type_room` ON `memories` (`type`,`roomId`);--> statement-breakpoint
CREATE INDEX `idx_memories_metadata_type` ON `memories` (`type`);--> statement-breakpoint
CREATE INDEX `idx_memories_document_id` ON `memories` (`id`);--> statement-breakpoint
CREATE INDEX `idx_fragments_order` ON `memories` (`id`);--> statement-breakpoint
CREATE INDEX `idx_participants_user` ON `participants` (`entityId`);--> statement-breakpoint
CREATE INDEX `idx_participants_room` ON `participants` (`roomId`);--> statement-breakpoint
CREATE INDEX `idx_relationships_users` ON `relationships` (`sourceEntityId`,`targetEntityId`);