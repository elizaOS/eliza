import * as fs from "node:fs";
import * as path from "node:path";
import type { IAgentRuntime, Memory, State, UUID } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { processKnowledgeAction } from "../actions";
import { KnowledgeService } from "../service";

// Mock the fs and path modules
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock("node:path", () => ({
  basename: vi.fn(),
  extname: vi.fn(),
}));

describe("processKnowledgeAction", () => {
  let agentRuntime: IAgentRuntime;
  let mockKnowledgeService: KnowledgeService;
  let mockCallback: ReturnType<typeof vi.fn>;
  let mockState: State;

  const generateMockUuid = (suffix: string | number): UUID =>
    `00000000-0000-0000-0000-${String(suffix).padStart(12, "0")}` as UUID;

  beforeEach(() => {
    mockKnowledgeService = {
      addKnowledge: vi.fn(),
      getKnowledge: vi.fn(),
      serviceType: "knowledge-service",
    } as KnowledgeService;

    agentRuntime = {
      agentId: "test-agent" as UUID,
      getService: vi.fn().mockReturnValue(mockKnowledgeService),
    } as Partial<IAgentRuntime> as IAgentRuntime;

    mockCallback = vi.fn();
    mockState = {
      values: {},
      data: {},
      text: "",
    };
    vi.clearAllMocks();
  });

  describe("handler", () => {
    beforeEach(() => {
      // Reset all mocks for each handler test
      vi.clearAllMocks();
    });

    it("should process a file when a valid path is provided", async () => {
      const message: Memory = {
        id: generateMockUuid(1),
        content: {
          text: "Process the document at /path/to/document.pdf",
        },
        entityId: generateMockUuid(2),
        roomId: generateMockUuid(3),
      };

      // Mock Date.now() for this test to generate predictable clientDocumentId's
      const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(1749491066994);

      (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(Buffer.from("file content"));
      (path.basename as ReturnType<typeof vi.fn>).mockReturnValue("document.pdf");
      (path.extname as ReturnType<typeof vi.fn>).mockReturnValue(".pdf");
      (mockKnowledgeService.addKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue({
        fragmentCount: 5,
      });

      await processKnowledgeAction.handler?.(agentRuntime, message, mockState, {}, mockCallback);

      expect(fs.existsSync).toHaveBeenCalledWith("/path/to/document.pdf");
      expect(fs.readFileSync).toHaveBeenCalledWith("/path/to/document.pdf");
      expect(mockKnowledgeService.addKnowledge).toHaveBeenCalledWith({
        clientDocumentId: "3050c984-5382-0cec-87ba-e5e31593e291",
        contentType: "application/pdf",
        originalFilename: "document.pdf",
        worldId: "test-agent" as UUID,
        content: Buffer.from("file content").toString("base64"),
        roomId: message.roomId,
        entityId: message.entityId,
      });
      expect(mockCallback).toHaveBeenCalledWith({
        text: `I've successfully processed the document "document.pdf". It has been split into 5 searchable fragments and added to my knowledge base.`,
      });

      // Restore Date.now() after the test
      dateNowSpy.mockRestore();
    });

    it("should return a message if the file path is provided but file does not exist", async () => {
      const message: Memory = {
        id: generateMockUuid(4),
        content: {
          text: "Process the document at /non/existent/file.txt",
        },
        entityId: generateMockUuid(5),
        roomId: generateMockUuid(6),
      };

      (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);

      await processKnowledgeAction.handler?.(agentRuntime, message, mockState, {}, mockCallback);

      expect(fs.existsSync).toHaveBeenCalledWith("/non/existent/file.txt");
      expect(fs.readFileSync).not.toHaveBeenCalled();
      expect(mockKnowledgeService.addKnowledge).not.toHaveBeenCalled();
      expect(mockCallback).toHaveBeenCalledWith({
        text: "I couldn't find the file at /non/existent/file.txt. Please check the path and try again.",
      });
    });

    it("should process direct text content when no file path is provided", async () => {
      // Mock Date.now() for this test to generate predictable clientDocumentId's
      const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(1749491066994);

      const message: Memory = {
        id: generateMockUuid(7),
        content: {
          text: "Add this to your knowledge: The capital of France is Paris.",
        },
        entityId: generateMockUuid(8),
        roomId: generateMockUuid(9),
      };

      (mockKnowledgeService.addKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue({
        fragmentCount: 1,
      });

      await processKnowledgeAction.handler?.(agentRuntime, message, mockState, {}, mockCallback);

      expect(fs.existsSync).not.toHaveBeenCalled();
      expect(mockKnowledgeService.addKnowledge).toHaveBeenCalledWith({
        clientDocumentId: "923470c7-bc8f-02be-a04a-1f45c3a983be" as UUID,
        contentType: "text/plain",
        originalFilename: "user-knowledge.txt",
        worldId: "test-agent" as UUID,
        content: "to your knowledge: The capital of France is Paris.",
        roomId: message.roomId,
        entityId: message.entityId,
      });
      expect(mockCallback).toHaveBeenCalledWith({
        text: "I've added that information to my knowledge base. It has been stored and indexed for future reference.",
      });

      // Restore Date.now() after the test
      dateNowSpy.mockRestore();
    });

    it("should return a message if no file path and no text content is provided", async () => {
      const message: Memory = {
        id: generateMockUuid(10),
        content: {
          text: "add this:",
        },
        entityId: generateMockUuid(11),
        roomId: generateMockUuid(12),
      };

      await processKnowledgeAction.handler?.(agentRuntime, message, mockState, {}, mockCallback);

      expect(fs.existsSync).not.toHaveBeenCalled();
      expect(mockKnowledgeService.addKnowledge).not.toHaveBeenCalled();
      expect(mockCallback).toHaveBeenCalledWith({
        text: "I need some content to add to my knowledge base. Please provide text or a file path.",
      });
    });

    it("should handle errors gracefully", async () => {
      const message: Memory = {
        id: generateMockUuid(13),
        content: {
          text: "Process /path/to/error.txt",
        },
        entityId: generateMockUuid(14),
        roomId: generateMockUuid(15),
      };

      (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(Buffer.from("error content"));
      (path.basename as ReturnType<typeof vi.fn>).mockReturnValue("error.txt");
      (path.extname as ReturnType<typeof vi.fn>).mockReturnValue(".txt");
      (mockKnowledgeService.addKnowledge as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Service error")
      );

      await processKnowledgeAction.handler?.(agentRuntime, message, mockState, {}, mockCallback);

      expect(mockCallback).toHaveBeenCalledWith({
        text: "I encountered an error while processing the knowledge: Service error",
      });
    });

    it("should generate unique clientDocumentId's for different documents and content", async () => {
      // Mock Date.now() for this test to generate predictable clientDocumentId's
      const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(1749491066994);

      // Test with two different files
      const fileMessage1: Memory = {
        id: generateMockUuid(28),
        content: {
          text: "Process the document at /path/to/doc1.pdf",
        },
        entityId: generateMockUuid(29),
        roomId: generateMockUuid(30),
      };

      const fileMessage2: Memory = {
        id: generateMockUuid(31),
        content: {
          text: "Process the document at /path/to/doc2.pdf",
        },
        entityId: generateMockUuid(32),
        roomId: generateMockUuid(33),
      };

      // Test with direct text content
      const textMessage: Memory = {
        id: generateMockUuid(34),
        content: {
          text: "Add this to your knowledge: Some unique content here.",
        },
        entityId: generateMockUuid(35),
        roomId: generateMockUuid(36),
      };

      // Setup mocks for file operations
      (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(Buffer.from("file content"));
      (path.basename as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce("doc1.pdf")
        .mockReturnValueOnce("doc2.pdf");
      (path.extname as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(".pdf")
        .mockReturnValueOnce(".pdf");

      // Mock addKnowledge to return results with fragment counts
      (mockKnowledgeService.addKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue({
        fragmentCount: 3,
      });

      // Process all three messages
      await processKnowledgeAction.handler?.(
        agentRuntime,
        fileMessage1,
        mockState,
        {},
        mockCallback
      );
      await processKnowledgeAction.handler?.(
        agentRuntime,
        fileMessage2,
        mockState,
        {},
        mockCallback
      );
      await processKnowledgeAction.handler?.(
        agentRuntime,
        textMessage,
        mockState,
        {},
        mockCallback
      );

      // Get all calls to addKnowledge
      const addKnowledgeCalls = (mockKnowledgeService.addKnowledge as ReturnType<typeof vi.fn>).mock
        .calls;

      // Extract clientDocumentId's from the knowledgeOptions objects
      const clientDocumentIds = addKnowledgeCalls.map(
        (call: unknown[]) => (call[0] as { clientDocumentId: string }).clientDocumentId
      );

      // Verify we have 3 unique IDs
      expect(clientDocumentIds.length).toBe(3);
      expect(new Set(clientDocumentIds).size).toBe(3);

      // Verify the IDs match the expected patterns
      const [file1Id, file2Id, textId] = clientDocumentIds;

      // File IDs should contain the filename
      expect(file1Id).toBe("d08e1b65-20ca-069a-b0c9-dd7b436a4d03");
      expect(file2Id).toBe("bf2aa191-bc3d-075f-a9d3-5e279794986f");

      // Text ID should contain the text pattern
      expect(textId).toBe("923470c7-bc8f-02be-a04a-1f45c3a983be");

      // Verify all IDs are different
      expect(file1Id).not.toBe(file2Id);
      expect(file1Id).not.toBe(textId);
      expect(file2Id).not.toBe(textId);

      // Restore Date.now() after the test
      dateNowSpy.mockRestore();
    });

    it("should generate unique clientDocumentId's for same content but different time", async () => {
      // Mock Date.now() for this test to generate predictable clientDocumentId's
      const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(1749491066994);

      // Test with two different files
      const textMessage1: Memory = {
        id: generateMockUuid(28),
        content: {
          text: "Add this to your knowledge: Some unique content here.",
        },
        entityId: generateMockUuid(29),
        roomId: generateMockUuid(30),
      };

      const textMessage2: Memory = {
        id: generateMockUuid(31),
        content: {
          text: "Add this to your knowledge: Some unique content here.",
        },
        entityId: generateMockUuid(32),
        roomId: generateMockUuid(33),
      };

      // Mock addKnowledge to return results with fragment counts
      (mockKnowledgeService.addKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue({
        fragmentCount: 1,
      });

      // Process all three messages
      await processKnowledgeAction.handler?.(
        agentRuntime,
        textMessage1,
        mockState,
        {},
        mockCallback
      );

      // Change Date.now() mock to generate a different timestamp
      dateNowSpy.mockRestore();
      const dateNowSpy2 = vi.spyOn(Date, "now").mockReturnValue(1749491066995);

      await processKnowledgeAction.handler?.(
        agentRuntime,
        textMessage2,
        mockState,
        {},
        mockCallback
      );

      // Get all calls to addKnowledge
      const addKnowledgeCalls = (mockKnowledgeService.addKnowledge as ReturnType<typeof vi.fn>).mock
        .calls;

      // Extract clientDocumentId's from the knowledgeOptions objects
      const clientDocumentIds = addKnowledgeCalls.map(
        (call: unknown[]) => (call[0] as { clientDocumentId: string }).clientDocumentId
      );

      // Verify we have 2 unique IDs
      expect(clientDocumentIds.length).toBe(2);
      expect(new Set(clientDocumentIds).size).toBe(2);

      // Verify the IDs match the expected patterns
      const [textId1, textId2] = clientDocumentIds;

      // Text ID should contain the text pattern
      expect(textId1).toBe("923470c7-bc8f-02be-a04a-1f45c3a983be");
      expect(textId2).toBe("209fdf12-aed1-01fb-800c-5bcfaacb988e");

      // Restore Date.now() after the test
      dateNowSpy2.mockRestore();
    });
  });

  describe("validate", () => {
    beforeEach(() => {
      (agentRuntime.getService as ReturnType<typeof vi.fn>).mockReturnValue(mockKnowledgeService);
    });

    it("should return true if knowledge keywords are present and service is available", async () => {
      const message: Memory = {
        id: generateMockUuid(16),
        content: {
          text: "add this to your knowledge base",
        },
        entityId: generateMockUuid(17),
        roomId: generateMockUuid(18),
      };
      const isValid = await processKnowledgeAction.validate?.(agentRuntime, message, mockState);
      expect(isValid).toBe(true);
      expect(agentRuntime.getService).toHaveBeenCalledWith(KnowledgeService.serviceType);
    });

    it("should return true if a file path is present and service is available", async () => {
      const message: Memory = {
        id: generateMockUuid(19),
        content: {
          text: "process /path/to/doc.pdf",
        },
        entityId: generateMockUuid(20),
        roomId: generateMockUuid(21),
      };
      const isValid = await processKnowledgeAction.validate?.(agentRuntime, message, mockState);
      expect(isValid).toBe(true);
    });

    it("should return false if service is not available", async () => {
      (agentRuntime.getService as ReturnType<typeof vi.fn>).mockReturnValue(null);
      const message: Memory = {
        id: generateMockUuid(22),
        content: {
          text: "add this to your knowledge base",
        },
        entityId: generateMockUuid(23),
        roomId: generateMockUuid(24),
      };
      const isValid = await processKnowledgeAction.validate?.(agentRuntime, message, mockState);
      expect(isValid).toBe(false);
    });

    it("should return false if no relevant keywords or path are present", async () => {
      const message: Memory = {
        id: generateMockUuid(25),
        content: {
          text: "hello there",
        },
        entityId: generateMockUuid(26),
        roomId: generateMockUuid(27),
      };
      const isValid = await processKnowledgeAction.validate?.(agentRuntime, message, mockState);
      expect(isValid).toBe(false);
    });
  });
});
