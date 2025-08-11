CREATE TABLE "memories" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "memories_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"agentId" integer NOT NULL,
	"content" text NOT NULL,
	"createdAt" timestamp DEFAULT now(),
	"updatedAt" timestamp DEFAULT now()
);
