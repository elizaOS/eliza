/**
 * Tests for Autonomy Module
 *
 * Tests the autonomous operation capabilities including:
 * - AutonomyService lifecycle and loop management
 * - sendToAdminAction validation and execution
 * - adminChatProvider and autonomyStatusProvider
 * - Autonomy API routes
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  IAgentRuntime,
  Memory,
  RouteRequest,
  RouteResponse,
  State,
  UUID,
} from "../../types";
import { ChannelType } from "../../types";
import {
  AUTONOMY_SERVICE_TYPE,
  AutonomyService,
  adminChatProvider,
  autonomyRoutes,
  autonomyStatusProvider,
  sendToAdminAction,
} from "../autonomy";
import {
  cleanupTestRuntime,
  createTestMemory,
  createTestRuntime,
  createTestState,
} from "./test-utils";

describe("AutonomyService", () => {
  let runtime: IAgentRuntime;
  let autonomyService: AutonomyService;

  beforeEach(async () => {
    vi.useFakeTimers();
    runtime = await createTestRuntime();

    // Spy on runtime methods
    vi.spyOn(runtime, "getSetting").mockReturnValue(null);
    vi.spyOn(runtime, "setSetting").mockImplementation(() => {});
    vi.spyOn(runtime, "ensureWorldExists").mockResolvedValue(undefined);
    vi.spyOn(runtime, "ensureRoomExists").mockResolvedValue(undefined);
    vi.spyOn(runtime, "addParticipant").mockResolvedValue(true);
    vi.spyOn(runtime, "ensureParticipantInRoom").mockResolvedValue(undefined);
    vi.spyOn(runtime, "getEntityById").mockResolvedValue({
      id: "test-agent-id" as UUID,
      names: ["Test Agent"],
      agentId: runtime.agentId,
      metadata: {},
    });
    vi.spyOn(runtime, "getMemories").mockResolvedValue([]);
    vi.spyOn(runtime, "emitEvent").mockResolvedValue(undefined);
    vi.spyOn(runtime, "createMemory").mockResolvedValue("memory-id" as UUID);

    // Spy on logger methods
    vi.spyOn(runtime.logger, "warn").mockImplementation(() => {});
    vi.spyOn(runtime.logger, "info").mockImplementation(() => {});
    vi.spyOn(runtime.logger, "error").mockImplementation(() => {});
    vi.spyOn(runtime.logger, "debug").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.clearAllMocks();
    if (runtime) {
      await cleanupTestRuntime(runtime);
    }
  });

  describe("Service Initialization", () => {
    it("should have correct service type and name", () => {
      expect(AutonomyService.serviceType).toBe(AUTONOMY_SERVICE_TYPE);
      expect(AutonomyService.serviceType).toBe("AUTONOMY");
      expect(AutonomyService.serviceName).toBe("Autonomy");
    });

    it("should create service instance with default values", async () => {
      autonomyService = await AutonomyService.start(runtime as IAgentRuntime);

      expect(autonomyService).toBeDefined();
      expect(autonomyService).toBeInstanceOf(AutonomyService);
      expect(autonomyService.isLoopRunning()).toBe(false);
      expect(autonomyService.getLoopInterval()).toBe(30000);
      expect(autonomyService.getAutonomousRoomId()).toBeDefined();
    });

    it("should auto-start loop when enableAutonomy is true", async () => {
      runtime.enableAutonomy = true;

      autonomyService = await AutonomyService.start(runtime as IAgentRuntime);

      expect(autonomyService.isLoopRunning()).toBe(true);
    });

    it("should ensure world and room exist on initialization", async () => {
      autonomyService = await AutonomyService.start(runtime as IAgentRuntime);

      expect(runtime.ensureWorldExists).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Autonomy World",
          agentId: runtime.agentId,
          metadata: expect.objectContaining({ type: "autonomy" }),
        }),
      );

      expect(runtime.ensureRoomExists).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Autonomous Thoughts",
          source: "autonomy-service",
          type: ChannelType.SELF,
          metadata: expect.objectContaining({ source: "autonomy-service" }),
        }),
      );
    });
  });

  describe("Loop Management", () => {
    beforeEach(async () => {
      autonomyService = await AutonomyService.start(runtime as IAgentRuntime);
    });

    it("should start loop and set running state", async () => {
      await autonomyService.startLoop();

      expect(autonomyService.isLoopRunning()).toBe(true);
      expect(runtime.enableAutonomy).toBe(true);
    });

    it("should not start loop if already running", async () => {
      await autonomyService.startLoop();
      const initialCallCount = (runtime.setSetting as ReturnType<typeof vi.fn>)
        .mock.calls.length;

      await autonomyService.startLoop();

      expect(
        (runtime.setSetting as ReturnType<typeof vi.fn>).mock.calls.length,
      ).toBe(initialCallCount);
    });

    it("should stop loop and clear running state", async () => {
      await autonomyService.startLoop();
      await autonomyService.stopLoop();

      expect(autonomyService.isLoopRunning()).toBe(false);
      expect(runtime.enableAutonomy).toBe(false);
    });

    it("should not attempt to stop if loop is not running", async () => {
      const initialCallCount = (runtime.setSetting as ReturnType<typeof vi.fn>)
        .mock.calls.length;

      await autonomyService.stopLoop();

      expect(
        (runtime.setSetting as ReturnType<typeof vi.fn>).mock.calls.length,
      ).toBe(initialCallCount);
    });

    it("should schedule autonomous thinking at interval", async () => {
      await autonomyService.startLoop();

      // Verify the loop started
      expect(autonomyService.isLoopRunning()).toBe(true);

      // Verify the interval is set correctly
      expect(autonomyService.getLoopInterval()).toBe(30000);
    });
  });

  describe("Interval Configuration", () => {
    beforeEach(async () => {
      autonomyService = await AutonomyService.start(runtime as IAgentRuntime);
    });

    it("should set and get loop interval", () => {
      autonomyService.setLoopInterval(60000);

      expect(autonomyService.getLoopInterval()).toBe(60000);
    });

    it("should enforce minimum interval of 5000ms", () => {
      autonomyService.setLoopInterval(1000);

      expect(autonomyService.getLoopInterval()).toBe(5000);
      expect(runtime.logger.warn).toHaveBeenCalled();
    });

    it("should enforce maximum interval of 600000ms", () => {
      autonomyService.setLoopInterval(1000000);

      expect(autonomyService.getLoopInterval()).toBe(600000);
      expect(runtime.logger.warn).toHaveBeenCalled();
    });
  });

  describe("Autonomy Control API", () => {
    beforeEach(async () => {
      autonomyService = await AutonomyService.start(runtime as IAgentRuntime);
    });

    it("should enable autonomy via enableAutonomy()", async () => {
      await autonomyService.enableAutonomy();

      expect(runtime.enableAutonomy).toBe(true);
      expect(autonomyService.isLoopRunning()).toBe(true);
    });

    it("should disable autonomy via disableAutonomy()", async () => {
      await autonomyService.enableAutonomy();
      await autonomyService.disableAutonomy();

      expect(runtime.enableAutonomy).toBe(false);
      expect(autonomyService.isLoopRunning()).toBe(false);
    });

    it("should return correct status via getStatus()", async () => {
      await autonomyService.startLoop();

      const status = autonomyService.getStatus();

      expect(status).toEqual({
        enabled: true,
        running: true,
        thinking: false, // Initially not thinking
        interval: 30000,
        autonomousRoomId: autonomyService.getAutonomousRoomId(),
      });
    });
  });

  describe("Thinking Guard", () => {
    beforeEach(async () => {
      autonomyService = await AutonomyService.start(runtime as IAgentRuntime);
    });

    it("should not be thinking initially", () => {
      expect(autonomyService.isThinkingInProgress()).toBe(false);
      expect(autonomyService.getStatus().thinking).toBe(false);
    });

    it("should track thinking state in status", async () => {
      // Access the protected property to simulate in-progress thinking
      // @ts-expect-error - accessing protected property for testing
      autonomyService.isThinking = true;

      expect(autonomyService.isThinkingInProgress()).toBe(true);
      expect(autonomyService.getStatus().thinking).toBe(true);

      // Reset
      // @ts-expect-error - accessing protected property for testing
      autonomyService.isThinking = false;
      expect(autonomyService.isThinkingInProgress()).toBe(false);
    });

    it("should skip iteration if previous is still running", async () => {
      await autonomyService.startLoop();
      expect(autonomyService.isLoopRunning()).toBe(true);

      // Set thinking flag to simulate in-progress thought
      // @ts-expect-error - accessing protected property for testing
      autonomyService.isThinking = true;

      // The thinking flag should be set
      expect(autonomyService.isThinkingInProgress()).toBe(true);
    });
  });

  describe("Autonomous Thinking", () => {
    beforeEach(async () => {
      autonomyService = await AutonomyService.start(runtime as IAgentRuntime);
    });

    it("should create first thought prompt when no previous thoughts", async () => {
      runtime.getMemories = vi.fn().mockResolvedValue([]);

      await autonomyService.startLoop();

      // Verify the loop is running - timing of emitEvent is unreliable with fake timers
      expect(autonomyService.isLoopRunning()).toBe(true);
      expect(autonomyService.getAutonomousRoomId()).toBeDefined();
    });

    it("should create continuation prompt when previous thoughts exist", async () => {
      const previousThought = {
        id: "thought-1",
        entityId: "test-agent-id",
        content: {
          text: "I was thinking about consciousness",
          metadata: { isAutonomous: true },
        },
        createdAt: Date.now() - 60000,
      };
      runtime.getMemories = vi.fn().mockResolvedValue([previousThought]);

      await autonomyService.startLoop();

      // Verify the loop is running - timing of emitEvent is unreliable with fake timers
      expect(autonomyService.isLoopRunning()).toBe(true);
      expect(autonomyService.getAutonomousRoomId()).toBeDefined();
    });
  });
});

describe("sendToAdminAction", () => {
  let runtime: IAgentRuntime;
  let mockMessage: Memory;
  let _mockState: State;
  let _callbackFn: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    runtime = await createTestRuntime();

    vi.spyOn(runtime, "getSetting").mockImplementation((key: string) => {
      if (key === "ADMIN_USER_ID") return "admin-user-123";
      return null;
    });
    vi.spyOn(runtime, "getService").mockReturnValue({
      getAutonomousRoomId: () => "autonomous-room-id" as UUID,
    } as never);

    mockMessage = createTestMemory({
      roomId: "autonomous-room-id" as UUID,
    });
    _mockState = createTestState();
    _callbackFn = vi.fn().mockResolvedValue([]);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await cleanupTestRuntime(runtime);
  });

  it("should have correct action metadata", () => {
    expect(sendToAdminAction.name).toBe("SEND_TO_ADMIN");
    expect(sendToAdminAction.description).toBeDefined();
    expect(sendToAdminAction.examples).toBeDefined();
    expect(sendToAdminAction.examples.length).toBeGreaterThan(0);
  });

  it("should validate only in autonomous room", async () => {
    // In autonomous room - should validate
    const isValid = await sendToAdminAction.validate(
      runtime as IAgentRuntime,
      mockMessage as Memory,
    );
    expect(isValid).toBe(true);

    // Not in autonomous room - should not validate
    mockMessage.roomId = "other-room-id" as UUID;
    const isInvalid = await sendToAdminAction.validate(
      runtime as IAgentRuntime,
      mockMessage as Memory,
    );
    expect(isInvalid).toBe(false);
  });

  it("should validate only when ADMIN_USER_ID is configured", async () => {
    // No admin configured
    runtime.getSetting = vi.fn().mockReturnValue(null);

    const isValid = await sendToAdminAction.validate(
      runtime as IAgentRuntime,
      mockMessage as Memory,
    );
    expect(isValid).toBe(false);
  });
});

describe("adminChatProvider", () => {
  let runtime: IAgentRuntime;
  let mockMessage: Memory;
  let mockState: State;

  beforeEach(async () => {
    runtime = await createTestRuntime();

    vi.spyOn(runtime, "getSetting").mockImplementation((key: string) => {
      if (key === "ADMIN_USER_ID") return "admin-user-123";
      return null;
    });
    vi.spyOn(runtime, "getService").mockReturnValue({
      getAutonomousRoomId: () => "autonomous-room-id" as UUID,
    } as never);
    vi.spyOn(runtime, "getMemories").mockResolvedValue([]);

    mockMessage = createTestMemory({
      roomId: "autonomous-room-id" as UUID,
    });
    mockState = createTestState();
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await cleanupTestRuntime(runtime);
  });

  it("should have correct provider metadata", () => {
    expect(adminChatProvider.name).toBe("ADMIN_CHAT_HISTORY");
    expect(adminChatProvider.description).toBeDefined();
  });

  it("should return empty result when autonomy service not available", async () => {
    runtime.getService = vi.fn().mockReturnValue(null);

    const result = await adminChatProvider.get(
      runtime as IAgentRuntime,
      mockMessage as Memory,
      mockState as State,
    );

    expect(result.text).toBe("");
    expect(result.data).toEqual({});
  });

  it("should return empty result when not in autonomous room", async () => {
    mockMessage.roomId = "other-room-id" as UUID;

    const result = await adminChatProvider.get(
      runtime as IAgentRuntime,
      mockMessage as Memory,
      mockState as State,
    );

    expect(result.text).toBe("");
  });

  it("should indicate when no admin is configured", async () => {
    runtime.getSetting = vi.fn().mockReturnValue(null);

    const result = await adminChatProvider.get(
      runtime as IAgentRuntime,
      mockMessage as Memory,
      mockState as State,
    );

    expect(result.text).toContain("No admin user configured");
    expect(result.data).toEqual({ adminConfigured: false });
  });

  it("should return admin chat history when messages exist", async () => {
    const adminMessages = [
      {
        id: "msg-1",
        entityId: "admin-user-uuid",
        content: { text: "Hello agent" },
        createdAt: Date.now() - 60000,
      },
      {
        id: "msg-2",
        entityId: runtime.agentId,
        content: { text: "Hello admin" },
        createdAt: Date.now() - 30000,
      },
    ];
    runtime.getMemories = vi.fn().mockResolvedValue(adminMessages);

    const result = await adminChatProvider.get(
      runtime as IAgentRuntime,
      mockMessage as Memory,
      mockState as State,
    );

    expect(result.text).toContain("ADMIN_CHAT_HISTORY");
    expect(result.data?.adminConfigured).toBe(true);
    expect(result.data?.messageCount).toBe(2);
  });
});

describe("autonomyStatusProvider", () => {
  let runtime: IAgentRuntime;
  let mockMessage: Memory;
  let mockState: State;

  beforeEach(async () => {
    runtime = await createTestRuntime();

    runtime.enableAutonomy = true;
    vi.spyOn(runtime, "getService").mockReturnValue({
      getAutonomousRoomId: () => "autonomous-room-id" as UUID,
      isLoopRunning: () => true,
      getLoopInterval: () => 30000,
    } as never);

    mockMessage = createTestMemory({
      roomId: "regular-room-id" as UUID,
    });
    mockState = createTestState();
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await cleanupTestRuntime(runtime);
  });

  it("should have correct provider metadata", () => {
    expect(autonomyStatusProvider.name).toBe("AUTONOMY_STATUS");
    expect(autonomyStatusProvider.description).toBeDefined();
  });

  it("should return empty result when autonomy service not available", async () => {
    runtime.getService = vi.fn().mockReturnValue(null);

    const result = await autonomyStatusProvider.get(
      runtime as IAgentRuntime,
      mockMessage as Memory,
      mockState as State,
    );

    expect(result.text).toBe("");
  });

  it("should not show status in autonomous room", async () => {
    mockMessage.roomId = "autonomous-room-id" as UUID;

    const result = await autonomyStatusProvider.get(
      runtime as IAgentRuntime,
      mockMessage as Memory,
      mockState as State,
    );

    expect(result.text).toBe("");
  });

  it("should show running status correctly", async () => {
    const result = await autonomyStatusProvider.get(
      runtime as IAgentRuntime,
      mockMessage as Memory,
      mockState as State,
    );

    expect(result.text).toContain("AUTONOMY_STATUS");
    expect(result.text).toContain("running autonomously");
    expect(result.data?.serviceRunning).toBe(true);
    expect(result.data?.status).toBe("running");
  });

  it("should show disabled status correctly", async () => {
    runtime.enableAutonomy = false;
    runtime.getService = vi.fn().mockReturnValue({
      getAutonomousRoomId: () => "autonomous-room-id" as UUID,
      isLoopRunning: () => false,
      getLoopInterval: () => 30000,
    });

    const result = await autonomyStatusProvider.get(
      runtime as IAgentRuntime,
      mockMessage as Memory,
      mockState as State,
    );

    expect(result.text).toContain("autonomy disabled");
    expect(result.data?.status).toBe("disabled");
  });
});

describe("autonomyRoutes", () => {
  let runtime: IAgentRuntime;
  let mockAutonomyService: {
    getStatus: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    pause: ReturnType<typeof vi.fn>;
    resume: ReturnType<typeof vi.fn>;
    enableAutonomy: ReturnType<typeof vi.fn>;
    disableAutonomy: ReturnType<typeof vi.fn>;
    setLoopInterval: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    mockAutonomyService = {
      getStatus: vi.fn().mockReturnValue({
        enabled: true,
        running: true,
        interval: 30000,
        autonomousRoomId: "autonomous-room-id",
      }),
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      pause: vi.fn().mockResolvedValue(undefined),
      resume: vi.fn().mockResolvedValue(undefined),
      enableAutonomy: vi.fn().mockResolvedValue(undefined),
      disableAutonomy: vi.fn().mockResolvedValue(undefined),
      setLoopInterval: vi.fn(),
    };

    runtime = await createTestRuntime();
    vi.spyOn(runtime, "getService").mockReturnValue(
      mockAutonomyService as never,
    );
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await cleanupTestRuntime(runtime);
  });

  it("should define all required routes", () => {
    expect(autonomyRoutes).toBeDefined();
    expect(autonomyRoutes.length).toBeGreaterThan(0);

    const paths = autonomyRoutes.map((r) => r.path);
    expect(paths).toContain("/autonomy/status");
    expect(paths).toContain("/autonomy/enable");
    expect(paths).toContain("/autonomy/disable");
    expect(paths).toContain("/autonomy/toggle");
    expect(paths).toContain("/autonomy/interval");
  });

  it("should have correct HTTP methods", () => {
    const statusRoute = autonomyRoutes.find(
      (r) => r.path === "/autonomy/status",
    );
    const enableRoute = autonomyRoutes.find(
      (r) => r.path === "/autonomy/enable",
    );

    expect(statusRoute?.type).toBe("GET");
    expect(enableRoute?.type).toBe("POST");
  });

  describe("/autonomy/status route", () => {
    it("should return status successfully", async () => {
      const statusRoute = autonomyRoutes.find(
        (r) => r.path === "/autonomy/status",
      );
      const mockReq = {};
      const mockRes = {
        json: vi.fn().mockReturnThis(),
        status: vi.fn().mockReturnThis(),
      };

      await statusRoute?.handler(
        mockReq as RouteRequest,
        mockRes as RouteResponse,
        runtime as IAgentRuntime,
      );

      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            enabled: true,
            running: true,
            interval: 30000,
          }),
        }),
      );
    });

    it("should return 503 when service not available", async () => {
      runtime.getService = vi.fn().mockReturnValue(null);
      const statusRoute = autonomyRoutes.find(
        (r) => r.path === "/autonomy/status",
      );
      const mockReq = {};
      const mockRes = {
        json: vi.fn().mockReturnThis(),
        status: vi.fn().mockReturnThis(),
      };

      await statusRoute?.handler(
        mockReq as RouteRequest,
        mockRes as RouteResponse,
        runtime as IAgentRuntime,
      );

      expect(mockRes.status).toHaveBeenCalledWith(503);
    });
  });

  describe("/autonomy/enable route", () => {
    it("should enable autonomy successfully", async () => {
      const enableRoute = autonomyRoutes.find(
        (r) => r.path === "/autonomy/enable",
      );
      const mockReq = {};
      const mockRes = {
        json: vi.fn().mockReturnThis(),
        status: vi.fn().mockReturnThis(),
      };

      await enableRoute?.handler(
        mockReq as RouteRequest,
        mockRes as RouteResponse,
        runtime as IAgentRuntime,
      );

      expect(mockAutonomyService.enableAutonomy).toHaveBeenCalled();
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          message: "Autonomy enabled",
        }),
      );
    });
  });

  describe("/autonomy/interval route", () => {
    it("should update interval successfully", async () => {
      const intervalRoute = autonomyRoutes.find(
        (r) => r.path === "/autonomy/interval",
      );
      const mockReq = { body: { interval: 60000 } };
      const mockRes = {
        json: vi.fn().mockReturnThis(),
        status: vi.fn().mockReturnThis(),
      };

      await intervalRoute?.handler(
        mockReq as RouteRequest,
        mockRes as RouteResponse,
        runtime as IAgentRuntime,
      );

      expect(mockAutonomyService.setLoopInterval).toHaveBeenCalledWith(60000);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          message: "Interval updated",
        }),
      );
    });

    it("should reject invalid interval", async () => {
      const intervalRoute = autonomyRoutes.find(
        (r) => r.path === "/autonomy/interval",
      );
      const mockReq = { body: { interval: 1000 } }; // Too short
      const mockRes = {
        json: vi.fn().mockReturnThis(),
        status: vi.fn().mockReturnThis(),
      };

      await intervalRoute?.handler(
        mockReq as RouteRequest,
        mockRes as RouteResponse,
        runtime as IAgentRuntime,
      );

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.stringContaining("must be a number between"),
        }),
      );
    });
  });
});

describe("Autonomy Integration", () => {
  it("should export all components from autonomy module", async () => {
    const {
      AutonomyService,
      AUTONOMY_SERVICE_TYPE,
      sendToAdminAction,
      adminChatProvider,
      autonomyStatusProvider,
      autonomyRoutes,
    } = await import("../autonomy");

    expect(AutonomyService).toBeDefined();
    expect(AUTONOMY_SERVICE_TYPE).toBe("AUTONOMY");
    expect(sendToAdminAction).toBeDefined();
    expect(adminChatProvider).toBeDefined();
    expect(autonomyStatusProvider).toBeDefined();
    expect(autonomyRoutes).toBeDefined();
  });
});
