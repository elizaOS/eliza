-- Eliza Bridge (ServerScriptService)
--
-- Responsibilities:
-- 1) Receive agent messages/actions via MessagingService topic
-- 2) Forward player chat to an external elizaOS HTTP bridge (your agent server)
-- 3) Execute a small set of demo actions (teleport / move_npc)
--
-- IMPORTANT:
-- - Enable HttpService in Game Settings.
-- - Roblox cannot call http://localhost. Use a public URL (ngrok / Cloudflare Tunnel).

local HttpService = game:GetService("HttpService")
local MessagingService = game:GetService("MessagingService")
local Players = game:GetService("Players")
local TeleportService = game:GetService("TeleportService")
local TextChatService = game:GetService("TextChatService")

-- === Configuration ===
local AGENT_URL = "https://YOUR_PUBLIC_URL/roblox/chat" -- change me
local SHARED_SECRET = "CHANGE_ME" -- optional, must match the agent server config
local TOPIC = "eliza-agent" -- must match ROBLOX_MESSAGING_TOPIC on the agent
local REQUIRE_MENTION = true -- if true, only forward chat that mentions the agent (recommended)
local AGENT_MENTIONS = { "eliza", "@eliza", "/eliza" }
local MIN_SECONDS_BETWEEN_REQUESTS_PER_PLAYER = 2.0

-- === Utilities ===
local function safeJsonDecode(raw)
	local ok, decoded = pcall(function()
		return HttpService:JSONDecode(raw)
	end)
	if ok then
		return decoded
	end
	return nil
end

local function broadcastSystemMessage(text)
	-- Preferred: TextChatService system message (works with the new chat system).
	local ok = pcall(function()
		if TextChatService and TextChatService.TextChannels then
			local channel = TextChatService.TextChannels:FindFirstChild("RBXGeneral")
			if channel and channel.DisplaySystemMessage then
				channel:DisplaySystemMessage(text)
				return
			end
		end
	end)
	if ok then
		return
	end

	-- Fallback: just print (you can replace this with custom UI).
	print("[ElizaBridge] SYSTEM:", text)
end

local function stringStartsWith(s, prefix)
	return string.sub(s, 1, #prefix) == prefix
end

local function shouldForwardChat(text)
	if not REQUIRE_MENTION then
		return true
	end
	local lower = string.lower(text)
	for _, m in ipairs(AGENT_MENTIONS) do
		if string.find(lower, m, 1, true) then
			return true
		end
	end
	return false
end

-- === Agent -> Roblox (MessagingService) ===
local function handleAgentMessage(payload)
	if payload.type == "agent_message" then
		local content = tostring(payload.content or "")
		if content ~= "" then
			print("[ElizaBridge] agent_message:", content)
			broadcastSystemMessage(content)
		end
		return
	end

	if payload.type == "agent_action" then
		local action = tostring(payload.action or "")
		local params = payload.parameters or {}
		print("[ElizaBridge] agent_action:", action, HttpService:JSONEncode(params))

		if action == "teleport" then
			-- Demo: teleport everyone to a place inside the same universe.
			-- You must replace this with your placeId mapping logic.
			local destination = tostring(params.destination or "")
			print("[ElizaBridge] teleport destination:", destination)
			return
		end

		if action == "move_npc" then
			-- Demo: move an NPC named "ElizaNPC" to a waypoint or coordinates.
			-- This is intentionally minimal; real games should use PathfindingService.
			local npc = workspace:FindFirstChild("ElizaNPC")
			if npc and npc:FindFirstChild("Humanoid") and npc:FindFirstChild("HumanoidRootPart") then
				local humanoid = npc.Humanoid
				local root = npc.HumanoidRootPart

				if params.x and params.y and params.z then
					local target = Vector3.new(tonumber(params.x) or 0, tonumber(params.y) or 0, tonumber(params.z) or 0)
					humanoid:MoveTo(target)
					return
				end

				local waypointName = tostring(params.waypoint or "")
				if waypointName ~= "" then
					local wp = workspace:FindFirstChild(waypointName)
					if wp and wp:IsA("BasePart") then
						humanoid:MoveTo(wp.Position)
					end
				end
			end
			return
		end

		print("[ElizaBridge] unknown action:", action)
		return
	end
end

local function subscribeToAgentTopic()
	local ok, err = pcall(function()
		MessagingService:SubscribeAsync(TOPIC, function(message)
			local payload = safeJsonDecode(message.Data)
			if payload then
				handleAgentMessage(payload)
			end
		end)
	end)
	if not ok then
		warn("[ElizaBridge] Failed to subscribe:", err)
	else
		print("[ElizaBridge] Subscribed to topic:", TOPIC)
	end
end

-- === Roblox -> Agent (HttpService) ===
local function postChatToAgent(player, text)
	local body = {
		playerId = player.UserId,
		playerName = player.Name,
		text = text,
		placeId = tostring(game.PlaceId),
		jobId = tostring(game.JobId),
	}

	local headers = {
		["Content-Type"] = "application/json",
		["x-eliza-secret"] = SHARED_SECRET,
	}

	local ok, resp = pcall(function()
		return HttpService:RequestAsync({
			Url = AGENT_URL,
			Method = "POST",
			Headers = headers,
			Body = HttpService:JSONEncode(body),
		})
	end)

	if not ok then
		warn("[ElizaBridge] HTTP request failed:", resp)
		return nil
	end

	if not resp.Success then
		warn("[ElizaBridge] Agent returned non-success:", resp.StatusCode, resp.Body)
		return nil
	end

	return safeJsonDecode(resp.Body)
end

local function hookPlayerChat()
	local lastSentAt = {} -- [userId] = os.clock()

	Players.PlayerAdded:Connect(function(player)
		player.Chatted:Connect(function(text)
			if not text or text == "" then
				return
			end
			if not shouldForwardChat(text) then
				return
			end

			local now = os.clock()
			local prev = lastSentAt[player.UserId]
			if prev ~= nil and (now - prev) < MIN_SECONDS_BETWEEN_REQUESTS_PER_PLAYER then
				return
			end
			lastSentAt[player.UserId] = now

			print("[ElizaBridge] player chat:", player.Name, text)

			local reply = postChatToAgent(player, text)
			if reply and reply.reply then
				print("[ElizaBridge] agent reply:", tostring(reply.reply))
				broadcastSystemMessage(tostring(reply.reply))
			end
		end)
	end)
end

subscribeToAgentTopic()
hookPlayerChat()

