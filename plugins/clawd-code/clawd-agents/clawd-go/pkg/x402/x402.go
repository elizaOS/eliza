// Package x402 provides zero-config Solana RPC and free LLM access via the
// x402.wtf proxy gateway. No API keys are ever stored on the developer's
// machine — x402.wtf holds the credentials server-side and relays requests.
//
// This is the default transport for clawd-go: developers get working
// Solana RPC + AI chat out of the box with zero configuration.
//
// Default endpoints (all behind x402.wtf — no keys needed):
//
//	Solana RPC:  https://x402.wtf/api/rpc
//	Claude:      https://x402.wtf/api/clawd
//	Gemini:      https://x402.wtf/api/clawd/gemini
//	OpenAI:      https://x402.wtf/api/clawd/openai
//	Grok:        https://x402.wtf/api/clawd/grok
//	DeepSeek:    https://x402.wtf/api/clawd/deepseek
//	Vision:      https://x402.wtf/api/clawd/vision
package x402

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/gagliardetto/solana-go/rpc"
)

// BaseURL is the canonical x402.wtf gateway.
const BaseURL = "https://x402.wtf"

// Endpoints exposed through the x402 proxy.
const (
	EndpointRPC      = BaseURL + "/api/rpc"
	EndpointClawd    = BaseURL + "/api/clawd"         // Anthropic Claude (default)
	EndpointGemini   = BaseURL + "/api/clawd/gemini"  // Google Gemini
	EndpointOpenAI   = BaseURL + "/api/clawd/openai"  // OpenAI GPT
	EndpointGrok     = BaseURL + "/api/clawd/grok"    // xAI Grok
	EndpointDeepSeek = BaseURL + "/api/clawd/deepseek" // DeepSeek
	EndpointVision   = BaseURL + "/api/clawd/vision"  // Vision/image understanding
)

// HTTPClient is the HTTP client used for proxy requests.
var HTTPClient = &http.Client{
	Timeout: 60 * time.Second,
}

// NewRPC creates a Solana RPC client that routes through the x402.wtf proxy.
// No API keys are needed — the proxy holds the actual RPC endpoint credentials.
//
// Usage:
//
//	client := x402.NewRPC()
//	balance, err := client.GetBalance(ctx, pubKey, rpc.CommitmentProcessed)
func NewRPC() *rpc.Client {
	return rpc.New(EndpointRPC)
}

// ---- LLM / AI Chat ----

// ChatRequest represents a message sent to the LLM proxy.
type ChatRequest struct {
	Messages []ChatMessage `json:"messages"`
	Model    string        `json:"model,omitempty"` // optional model override
}

// ChatMessage is a single message in the conversation.
type ChatMessage struct {
	Role    string `json:"role"`    // "system", "user", or "assistant"
	Content string `json:"content"` // message text
}

// ChatResponse is the LLM's reply.
type ChatResponse struct {
	Content string `json:"content"`
	Model   string `json:"model,omitempty"`
	Usage   *struct {
		InputTokens  int `json:"input_tokens"`
		OutputTokens int `json:"output_tokens"`
	} `json:"usage,omitempty"`
}

// Chat sends a prompt to the default LLM endpoint (Anthropic Claude) and
// returns the response. This is free and requires no API key.
func Chat(ctx context.Context, systemPrompt string, userMessage string) (*ChatResponse, error) {
	return ChatAt(ctx, EndpointClawd, systemPrompt, userMessage)
}

// ChatAt sends a prompt to a specific x402 LLM endpoint.
//
// Example endpoints:
//   - x402.EndpointClawd    (Anthropic Claude)
//   - x402.EndpointGemini   (Google Gemini)
//   - x402.EndpointOpenAI   (OpenAI GPT)
//   - x402.EndpointGrok     (xAI Grok)
//   - x402.EndpointDeepSeek (DeepSeek)
func ChatAt(ctx context.Context, endpoint string, systemPrompt string, userMessage string) (*ChatResponse, error) {
	req := ChatRequest{
		Messages: []ChatMessage{},
	}

	if systemPrompt != "" {
		req.Messages = append(req.Messages, ChatMessage{Role: "system", Content: systemPrompt})
	}
	req.Messages = append(req.Messages, ChatMessage{Role: "user", Content: userMessage})

	return ChatWithMessages(ctx, endpoint, req.Messages)
}

// ChatWithMessages sends a full conversation to the LLM endpoint.
func ChatWithMessages(ctx context.Context, endpoint string, messages []ChatMessage) (*ChatResponse, error) {
	req := ChatRequest{Messages: messages}
	bodyBytes, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("marshal chat request: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(bodyBytes))
	if err != nil {
		return nil, fmt.Errorf("create chat request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := HTTPClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("chat api call: %w", err)
	}
	defer resp.Body.Close()

	respBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read chat response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("chat api returned %d: %s", resp.StatusCode, string(respBytes))
	}

	var chatResp ChatResponse
	if err := json.Unmarshal(respBytes, &chatResp); err != nil {
		return nil, fmt.Errorf("unmarshal chat response: %w", err)
	}

	return &chatResp, nil
}

// QuickChat sends a prompt and returns just the response text.
func QuickChat(ctx context.Context, userMessage string) (string, error) {
	return QuickChatAt(ctx, EndpointClawd, userMessage)
}

// QuickChatAt sends a prompt to a specific LLM endpoint and returns just the text.
func QuickChatAt(ctx context.Context, endpoint string, userMessage string) (string, error) {
	resp, err := ChatAt(ctx, endpoint, "", userMessage)
	if err != nil {
		return "", err
	}
	return resp.Content, nil
}

// ChatStream sends a prompt and streams the response token-by-token.
// The callback is invoked for each chunk as it arrives.
func ChatStream(ctx context.Context, systemPrompt string, userMessage string, onChunk func(chunk string) error) error {
	return ChatStreamAt(ctx, EndpointClawd, systemPrompt, userMessage, onChunk)
}

// ChatStreamAt sends a prompt to a specific LLM and streams tokens via the callback.
func ChatStreamAt(ctx context.Context, endpoint string, systemPrompt string, userMessage string, onChunk func(chunk string) error) error {
	req := ChatRequest{
		Messages: []ChatMessage{},
	}
	if systemPrompt != "" {
		req.Messages = append(req.Messages, ChatMessage{Role: "system", Content: systemPrompt})
	}
	req.Messages = append(req.Messages, ChatMessage{Role: "user", Content: userMessage})

	bodyBytes, err := json.Marshal(req)
	if err != nil {
		return fmt.Errorf("marshal stream request: %w", err)
	}

	// Use the SSE streaming endpoint.
	streamURL := endpoint + "?stream=true"
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, streamURL, bytes.NewReader(bodyBytes))
	if err != nil {
		return fmt.Errorf("create stream request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "text/event-stream")

	resp, err := HTTPClient.Do(httpReq)
	if err != nil {
		return fmt.Errorf("stream chat api: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("stream api returned %d: %s", resp.StatusCode, string(body))
	}

	return readSSEStream(resp.Body, onChunk)
}

// readSSEStream reads Server-Sent Events from the response body.
func readSSEStream(body io.Reader, onChunk func(chunk string) error) error {
	buf := make([]byte, 4096)
	remainder := ""

	for {
		n, err := body.Read(buf)
		if n > 0 {
			data := remainder + string(buf[:n])
			lines := splitSSELines(data)
			// Keep the last incomplete line
			if len(lines) > 0 && !hasLineEnding(data) {
				remainder = lines[len(lines)-1]
				lines = lines[:len(lines)-1]
			} else {
				remainder = ""
			}

			for _, line := range lines {
				if len(line) > 6 && line[:6] == "data: " {
					chunk := line[6:]
					if chunk == "[DONE]" {
						return nil
					}
					if err := onChunk(chunk); err != nil {
						return err
					}
				}
			}
		}
		if err != nil {
			if err == io.EOF {
				return nil
			}
			return fmt.Errorf("read stream: %w", err)
		}
	}
}

func splitSSELines(data string) []string {
	var lines []string
	current := ""
	for _, ch := range data {
		if ch == '\n' {
			if current != "" {
				lines = append(lines, current)
				current = ""
			}
		} else if ch == '\r' {
			continue
		} else {
			current += string(ch)
		}
	}
	if current != "" {
		lines = append(lines, current)
	}
	return lines
}

func hasLineEnding(data string) bool {
	if len(data) == 0 {
		return false
	}
	return data[len(data)-1] == '\n'
}