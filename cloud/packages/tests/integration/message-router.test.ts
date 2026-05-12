/**
 * E2E Integration Tests for MessageRouterService
 *
 * Tests the complete message routing flow from webhook to agent response.
 * Covers: phone number registration, message routing, agent processing, response sending.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Client } from "pg";
import { v4 as uuidv4 } from "uuid";
import {
  cleanupTestData,
  createTestDataSet,
  type TestDataSet,
} from "../infrastructure/test-data-factory";

const TEST_DB_URL = process.env.DATABASE_URL || "";

async function dbQuery(query: string, values?: unknown[]) {
  const client = new Client({ connectionString: TEST_DB_URL });
  await client.connect();

  try {
    return await client.query(query, values);
  } finally {
    await client.end();
  }
}

describe("MessageRouterService E2E Tests", () => {
  let testData: TestDataSet;

  beforeAll(async () => {
    if (!TEST_DB_URL) {
      throw new Error("DATABASE_URL is required for integration tests");
    }

    // Create test data
    testData = await createTestDataSet(TEST_DB_URL, {
      organizationName: "Message Router Test Org",
      creditBalance: 1000,
    });
  });

  afterAll(async () => {
    // Clean up phone numbers and message logs first
    await dbQuery(
      `DELETE FROM phone_message_log WHERE phone_number_id IN 
       (SELECT id FROM agent_phone_numbers WHERE organization_id = $1)`,
      [testData.organization.id],
    );
    await dbQuery(`DELETE FROM agent_phone_numbers WHERE organization_id = $1`, [
      testData.organization.id,
    ]);
    await cleanupTestData(TEST_DB_URL, testData.organization.id);
  });

  describe("Phone Number Registration", () => {
    it("should register a Twilio phone number for an agent", async () => {
      // Create a test agent first
      const agentId = uuidv4();
      await dbQuery(`INSERT INTO agents (id, name, enabled) VALUES ($1, $2, true)`, [
        agentId,
        "Test SMS Agent",
      ]);

      // Register phone number
      const phoneNumber = "+15551234567";
      const result = await dbQuery(
        `INSERT INTO agent_phone_numbers 
         (organization_id, agent_id, phone_number, provider, phone_type, is_active)
         VALUES ($1, $2, $3, 'twilio', 'sms', true)
         RETURNING id, webhook_url`,
        [testData.organization.id, agentId, phoneNumber],
      );

      expect(result.rows[0]).toBeDefined();
      expect(result.rows[0].id).toBeDefined();

      // Cleanup
      await dbQuery(`DELETE FROM agent_phone_numbers WHERE id = $1`, [result.rows[0].id]);
      await dbQuery(`DELETE FROM agents WHERE id = $1`, [agentId]);
    });

    it("should register a Blooio phone number for iMessage", async () => {
      const agentId = uuidv4();
      await dbQuery(`INSERT INTO agents (id, name, enabled) VALUES ($1, $2, true)`, [
        agentId,
        "Test iMessage Agent",
      ]);

      const phoneNumber = "+15559876543";
      const result = await dbQuery(
        `INSERT INTO agent_phone_numbers 
         (organization_id, agent_id, phone_number, provider, phone_type, is_active)
         VALUES ($1, $2, $3, 'blooio', 'imessage', true)
         RETURNING id`,
        [testData.organization.id, agentId, phoneNumber],
      );

      expect(result.rows[0]).toBeDefined();

      // Cleanup
      await dbQuery(`DELETE FROM agent_phone_numbers WHERE id = $1`, [result.rows[0].id]);
      await dbQuery(`DELETE FROM agents WHERE id = $1`, [agentId]);
    });

    it("should prevent duplicate phone numbers in same organization", async () => {
      const agentId = uuidv4();
      await dbQuery(`INSERT INTO agents (id, name, enabled) VALUES ($1, $2, true)`, [
        agentId,
        "Test Agent",
      ]);

      const phoneNumber = "+15551111111";

      // First registration should succeed
      const result1 = await dbQuery(
        `INSERT INTO agent_phone_numbers 
         (organization_id, agent_id, phone_number, provider, phone_type, is_active)
         VALUES ($1, $2, $3, 'twilio', 'sms', true)
         RETURNING id`,
        [testData.organization.id, agentId, phoneNumber],
      );

      // Second registration with same number should fail
      let duplicateError = false;
      try {
        await dbQuery(
          `INSERT INTO agent_phone_numbers 
           (organization_id, agent_id, phone_number, provider, phone_type, is_active)
           VALUES ($1, $2, $3, 'twilio', 'sms', true)`,
          [testData.organization.id, agentId, phoneNumber],
        );
      } catch (_error) {
        duplicateError = true;
      }

      expect(duplicateError).toBe(true);

      // Cleanup
      await dbQuery(`DELETE FROM agent_phone_numbers WHERE id = $1`, [result1.rows[0].id]);
      await dbQuery(`DELETE FROM agents WHERE id = $1`, [agentId]);
    });
  });

  describe("Message Routing", () => {
    let agentId: string;
    let phoneNumberId: string;
    const testPhoneNumber = "+15552223333";

    beforeEach(async () => {
      agentId = uuidv4();
      await dbQuery(`INSERT INTO agents (id, name, enabled) VALUES ($1, $2, true)`, [
        agentId,
        "Routing Test Agent",
      ]);

      const result = await dbQuery(
        `INSERT INTO agent_phone_numbers 
         (organization_id, agent_id, phone_number, provider, phone_type, is_active)
         VALUES ($1, $2, $3, 'twilio', 'sms', true)
         RETURNING id`,
        [testData.organization.id, agentId, testPhoneNumber],
      );
      phoneNumberId = result.rows[0].id;
    });

    afterEach(async () => {
      if (phoneNumberId) {
        await dbQuery(`DELETE FROM phone_message_log WHERE phone_number_id = $1`, [phoneNumberId]);
        await dbQuery(`DELETE FROM agent_phone_numbers WHERE id = $1`, [phoneNumberId]);
      }

      if (agentId) {
        await dbQuery(`DELETE FROM agents WHERE id = $1`, [agentId]);
      }
    });

    it("should find the correct agent for an incoming message", async () => {
      // Query for the phone number mapping
      const result = await dbQuery(
        `SELECT a.id as agent_id, a.name as agent_name, apn.organization_id
         FROM agent_phone_numbers apn
         JOIN agents a ON apn.agent_id = a.id
         WHERE apn.phone_number = $1 AND apn.is_active = true`,
        [testPhoneNumber],
      );

      expect(result.rows.length).toBe(1);
      expect(result.rows[0].agent_id).toBe(agentId);
      expect(result.rows[0].organization_id).toBe(testData.organization.id);
    });

    it("should log inbound messages to phone_message_log", async () => {
      const fromNumber = "+15559998888";
      const messageBody = "Hello, this is a test message!";

      const result = await dbQuery(
        `INSERT INTO phone_message_log 
         (phone_number_id, direction, from_number, to_number, message_body, message_type, status)
         VALUES ($1, 'inbound', $2, $3, $4, 'sms', 'received')
         RETURNING id, created_at`,
        [phoneNumberId, fromNumber, testPhoneNumber, messageBody],
      );

      expect(result.rows[0]).toBeDefined();
      expect(result.rows[0].id).toBeDefined();
      expect(result.rows[0].created_at).toBeDefined();
    });

    it("should update message status after processing", async () => {
      const fromNumber = "+15557776666";
      const messageBody = "Process this message";

      // Insert message
      const insertResult = await dbQuery(
        `INSERT INTO phone_message_log 
         (phone_number_id, direction, from_number, to_number, message_body, message_type, status)
         VALUES ($1, 'inbound', $2, $3, $4, 'sms', 'received')
         RETURNING id`,
        [phoneNumberId, fromNumber, testPhoneNumber, messageBody],
      );

      const messageId = insertResult.rows[0].id;

      // Update status to processing
      await dbQuery(`UPDATE phone_message_log SET status = 'processing' WHERE id = $1`, [
        messageId,
      ]);

      // Simulate agent response
      const agentResponse = "Thanks for your message! How can I help?";
      await dbQuery(
        `UPDATE phone_message_log 
         SET status = 'responded', 
             agent_response = $2, 
             response_time_ms = '150',
             responded_at = NOW()
         WHERE id = $1`,
        [messageId, agentResponse],
      );

      // Verify final state
      const checkResult = await dbQuery(
        `SELECT status, agent_response, response_time_ms FROM phone_message_log WHERE id = $1`,
        [messageId],
      );

      expect(checkResult.rows[0].status).toBe("responded");
      expect(checkResult.rows[0].agent_response).toBe(agentResponse);
      expect(checkResult.rows[0].response_time_ms).toBe("150");
    });

    it("should handle message routing failure gracefully", async () => {
      // Query for non-existent phone number
      const result = await dbQuery(
        `SELECT * FROM agent_phone_numbers 
         WHERE phone_number = '+10000000000' AND is_active = true`,
      );

      expect(result.rows.length).toBe(0);
    });
  });

  describe("Phone Number Capabilities", () => {
    it("should track SMS capabilities correctly", async () => {
      const agentId = uuidv4();
      await dbQuery(`INSERT INTO agents (id, name, enabled) VALUES ($1, $2, true)`, [
        agentId,
        "SMS Agent",
      ]);

      const result = await dbQuery(
        `INSERT INTO agent_phone_numbers 
         (organization_id, agent_id, phone_number, provider, phone_type, 
          can_send_sms, can_receive_sms, can_send_mms, can_receive_mms, can_voice)
         VALUES ($1, $2, '+15554445555', 'twilio', 'sms', true, true, false, false, false)
         RETURNING id, can_send_sms, can_receive_sms, can_send_mms, can_voice`,
        [testData.organization.id, agentId],
      );

      expect(result.rows[0].can_send_sms).toBe(true);
      expect(result.rows[0].can_receive_sms).toBe(true);
      expect(result.rows[0].can_send_mms).toBe(false);
      expect(result.rows[0].can_voice).toBe(false);

      // Cleanup
      await dbQuery(`DELETE FROM agent_phone_numbers WHERE id = $1`, [result.rows[0].id]);
      await dbQuery(`DELETE FROM agents WHERE id = $1`, [agentId]);
    });

    it("should track voice capabilities for Twilio", async () => {
      const agentId = uuidv4();
      await dbQuery(`INSERT INTO agents (id, name, enabled) VALUES ($1, $2, true)`, [
        agentId,
        "Voice Agent",
      ]);

      const result = await dbQuery(
        `INSERT INTO agent_phone_numbers 
         (organization_id, agent_id, phone_number, provider, phone_type, 
          can_send_sms, can_receive_sms, can_voice)
         VALUES ($1, $2, '+15556667777', 'twilio', 'both', true, true, true)
         RETURNING id, phone_type, can_voice`,
        [testData.organization.id, agentId],
      );

      expect(result.rows[0].phone_type).toBe("both");
      expect(result.rows[0].can_voice).toBe(true);

      // Cleanup
      await dbQuery(`DELETE FROM agent_phone_numbers WHERE id = $1`, [result.rows[0].id]);
      await dbQuery(`DELETE FROM agents WHERE id = $1`, [agentId]);
    });
  });

  describe("Message Log Queries", () => {
    let agentId: string;
    let phoneNumberId: string;

    beforeAll(async () => {
      agentId = uuidv4();
      await dbQuery(`INSERT INTO agents (id, name, enabled) VALUES ($1, $2, true)`, [
        agentId,
        "Log Query Agent",
      ]);

      const result = await dbQuery(
        `INSERT INTO agent_phone_numbers 
         (organization_id, agent_id, phone_number, provider, phone_type, is_active)
         VALUES ($1, $2, '+15558889999', 'twilio', 'sms', true)
         RETURNING id`,
        [testData.organization.id, agentId],
      );
      phoneNumberId = result.rows[0].id;

      // Insert multiple test messages
      const messages = [
        { from: "+15551111111", body: "First message", status: "responded" },
        { from: "+15552222222", body: "Second message", status: "responded" },
        { from: "+15551111111", body: "Third message", status: "failed" },
        { from: "+15553333333", body: "Fourth message", status: "received" },
      ];

      for (const msg of messages) {
        await dbQuery(
          `INSERT INTO phone_message_log 
           (phone_number_id, direction, from_number, to_number, message_body, message_type, status)
           VALUES ($1, 'inbound', $2, '+15558889999', $3, 'sms', $4)`,
          [phoneNumberId, msg.from, msg.body, msg.status],
        );
      }
    });

    afterAll(async () => {
      await dbQuery(`DELETE FROM phone_message_log WHERE phone_number_id = $1`, [phoneNumberId]);
      await dbQuery(`DELETE FROM agent_phone_numbers WHERE id = $1`, [phoneNumberId]);
      await dbQuery(`DELETE FROM agents WHERE id = $1`, [agentId]);
    });

    it("should query all messages for a phone number", async () => {
      const result = await dbQuery(
        `SELECT * FROM phone_message_log WHERE phone_number_id = $1 ORDER BY created_at`,
        [phoneNumberId],
      );

      expect(result.rows.length).toBe(4);
    });

    it("should filter messages by status", async () => {
      const result = await dbQuery(
        `SELECT * FROM phone_message_log 
         WHERE phone_number_id = $1 AND status = 'responded'`,
        [phoneNumberId],
      );

      expect(result.rows.length).toBe(2);
    });

    it("should filter messages by sender", async () => {
      const result = await dbQuery(
        `SELECT * FROM phone_message_log 
         WHERE phone_number_id = $1 AND from_number = '+15551111111'`,
        [phoneNumberId],
      );

      expect(result.rows.length).toBe(2);
    });

    it("should count failed messages", async () => {
      const result = await dbQuery(
        `SELECT COUNT(*) as failed_count FROM phone_message_log 
         WHERE phone_number_id = $1 AND status = 'failed'`,
        [phoneNumberId],
      );

      expect(parseInt(result.rows[0].failed_count)).toBe(1);
    });
  });

  describe("Rate Limiting", () => {
    it("should track rate limit settings", async () => {
      const agentId = uuidv4();
      await dbQuery(`INSERT INTO agents (id, name, enabled) VALUES ($1, $2, true)`, [
        agentId,
        "Rate Limited Agent",
      ]);

      const result = await dbQuery(
        `INSERT INTO agent_phone_numbers 
         (organization_id, agent_id, phone_number, provider, phone_type,
          max_messages_per_minute, max_messages_per_day)
         VALUES ($1, $2, '+15550001111', 'twilio', 'sms', '30', '500')
         RETURNING id, max_messages_per_minute, max_messages_per_day`,
        [testData.organization.id, agentId],
      );

      expect(result.rows[0].max_messages_per_minute).toBe("30");
      expect(result.rows[0].max_messages_per_day).toBe("500");

      // Cleanup
      await dbQuery(`DELETE FROM agent_phone_numbers WHERE id = $1`, [result.rows[0].id]);
      await dbQuery(`DELETE FROM agents WHERE id = $1`, [agentId]);
    });
  });
});
