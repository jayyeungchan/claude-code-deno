// Deno Deploy Claude to OpenAI API Proxy Server with Load Balancing
// Converts Claude API format to OpenAI compatible format for Vercel AI Gateway
// Version with load balancing for multiple API keys

// Deno 全局对象声明（用于TypeScript类型检查）
declare const Deno: {
  env: {
    get(key: string): string | undefined;
  };
};

// --- Interfaces (保持不变) ---
interface ClaudeMessage {
  role: "user" | "assistant";
  content: string | Array<{ type: string; text?: string; [key: string]: any }>;
}

interface ClaudeRequest {
  model: string;
  messages: ClaudeMessage[];
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  tools?: any[];
  tool_choice?: any;
  [key: string]: any;
}

interface OpenAIMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  tools?: any[];
  tool_choice?: any;
  [key: string]: any;
}

// --- Constants with Load Balancing ---
// 从环境变量获取Vercel API URL
const VERCEL_API_URL = Deno.env.get("VERCEL_API_URL") || "https://ai-gateway.vercel.sh/v1/chat/completions";

// 从环境变量获取多个API密钥用于负载均衡
// 环境变量格式：VERCEL_API_KEYS="key1,key2,key3,key4"
const VERCEL_API_KEYS_ENV = Deno.env.get("VERCEL_API_KEYS");
const VERCEL_API_KEYS = VERCEL_API_KEYS_ENV 
  ? VERCEL_API_KEYS_ENV.split(",").map(key => key.trim()).filter(key => key.length > 0)
  : [];

// 从环境变量获取自定义认证密钥
// 环境变量格式：CUSTOM_AUTH_KEY="your-secret-key"
const CUSTOM_AUTH_KEY = Deno.env.get("CUSTOM_AUTH_KEY");

// Model mapping
const MODEL_MAPPING: { [key: string]: string } = {
  "claude-3-5-haiku-20241022": "anthropic/claude-3.5-haiku",
  "claude-sonnet-4-20250514": "anthropic/claude-sonnet-4",
  "claude-opus-4-20250514": "anthropic/claude-opus-4",
};

// --- Load Balancing Manager ---
class ApiKeyManager {
  private keys: string[];
  private currentIndex: number = 0;
  private failedKeys: Map<string, number> = new Map(); // 记录失败时间
  private readonly FAILURE_TIMEOUT = 60000; // 失败后60秒重试

  constructor(keys: string[]) {
    this.keys = keys;
    console.log(`Initialized API Key Manager with ${keys.length} keys`);
  }

  getKey(): string {
    // 清理过期的失败记录
    const now = Date.now();
    for (const [key, failTime] of this.failedKeys.entries()) {
      if (now - failTime > this.FAILURE_TIMEOUT) {
        this.failedKeys.delete(key);
        console.log(`Restored failed key: ${key.substring(0, 8)}...`);
      }
    }

    // 获取可用密钥
    const availableKeys = this.keys.filter(key => !this.failedKeys.has(key));
    
    if (availableKeys.length === 0) {
      console.warn("All keys are failed, clearing failure list and retrying");
      this.failedKeys.clear();
      const selectedKey = this.keys[this.currentIndex % this.keys.length];
      this.currentIndex++;
      return selectedKey;
    }

    // 轮询选择可用密钥
    const selectedKey = availableKeys[this.currentIndex % availableKeys.length];
    this.currentIndex++;
    
    console.log(`Selected API key: ${selectedKey.substring(0, 8)}... (${availableKeys.length}/${this.keys.length} available)`);
    return selectedKey;
  }

  markKeyAsFailed(key: string, error?: string) {
    this.failedKeys.set(key, Date.now());
    console.error(`Marked key as failed: ${key.substring(0, 8)}... Error: ${error || 'Unknown'}`);
  }

  getStats() {
    const available = this.keys.length - this.failedKeys.size;
    return {
      total: this.keys.length,
      available,
      failed: this.failedKeys.size
    };
  }
}

const keyManager = new ApiKeyManager(VERCEL_API_KEYS);

// --- 认证验证函数 ---
/**
 * 验证请求中的Bearer token是否与环境变量中设置的自定义密钥匹配
 * @param request - HTTP请求对象
 * @returns 如果认证成功返回true，否则返回false
 */
function validateBearerToken(request: Request): boolean {
  // 如果没有设置自定义认证密钥，则跳过验证
  if (!CUSTOM_AUTH_KEY) {
    return true;
  }

  const authHeader = request.headers.get("Authorization");
  if (!authHeader) {
    return false;
  }

  // 检查是否为Bearer token格式
  if (!authHeader.startsWith("Bearer ")) {
    return false;
  }

  // 提取token并与环境变量中的密钥比较
  const token = authHeader.substring(7); // 移除"Bearer "前缀
  return token === CUSTOM_AUTH_KEY;
}

// --- 主函数：转换 Claude 请求到 OpenAI 请求 ---
function convertClaudeToOpenAI(claudeRequest: ClaudeRequest): OpenAIRequest {
  // 1. 转换 messages
  const openaiMessages: OpenAIMessage[] = claudeRequest.messages.map(msg => ({
    role: msg.role,
    content: Array.isArray(msg.content) 
      ? msg.content.map(c => c.text || JSON.stringify(c)).join('\n')
      : msg.content
  }));

  // 2. 映射 model
  const openaiModel = MODEL_MAPPING[claudeRequest.model] || "anthropic/claude-4-sonnet";

  // 3. 转换 tools 数组
  const openaiTools = claudeRequest.tools?.map(tool => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema
    }
  }));

  // 4. 构建最终的 OpenAI 请求对象
  return {
    model: openaiModel,
    messages: openaiMessages,
    max_tokens: claudeRequest.max_tokens || 4096,
    temperature: claudeRequest.temperature || 0.7,
    stream: claudeRequest.stream || false,
    ...(openaiTools && { tools: openaiTools }),
    ...(claudeRequest.tool_choice && { tool_choice: claudeRequest.tool_choice })
  };
}

// --- 带重试机制的请求函数 ---
async function makeRequestWithRetry(openaiRequest: OpenAIRequest, maxRetries: number = 3): Promise<Response> {
  let lastError: string = "";
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const selectedKey = keyManager.getKey();
    
    try {
      console.log(`Attempt ${attempt}/${maxRetries} with key: ${selectedKey.substring(0, 8)}...`);
      
      const response = await fetch(VERCEL_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${selectedKey}`
        },
        body: JSON.stringify(openaiRequest)
      });

      if (response.ok) {
        console.log(`Request successful on attempt ${attempt}`);
        return response;
      }

      // 请求失败，记录错误
      const errorText = await response.text();
      lastError = `HTTP ${response.status}: ${errorText}`;
      
      // 特定错误码标记密钥失败
      if (response.status === 401 || response.status === 403) {
        keyManager.markKeyAsFailed(selectedKey, `HTTP ${response.status}`);
      }
      
      console.error(`Attempt ${attempt} failed: ${lastError}`);
      
      // 如果是最后一次尝试，返回错误响应
      if (attempt === maxRetries) {
        return new Response(errorText, { 
          status: response.status,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Content-Type": "application/json"
          }
        });
      }
      
    } catch (error) {
      lastError = error.message;
      keyManager.markKeyAsFailed(selectedKey, error.message);
      console.error(`Attempt ${attempt} failed with exception: ${lastError}`);
      
      if (attempt === maxRetries) {
        throw error;
      }
    }
    
    // 短暂延迟后重试
    await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
  }
  
  throw new Error(`All ${maxRetries} attempts failed. Last error: ${lastError}`);
}

// --- 辅助函数 (保持不变) ---
function convertOpenAIToClaude(openaiResponse: any): any {
  if (openaiResponse.choices && openaiResponse.choices[0]) {
    const choice = openaiResponse.choices[0];
    
    if (choice.message?.tool_calls) {
      return {
        id: openaiResponse.id || `msg_${Date.now()}`,
        type: "message",
        role: "assistant",
        content: choice.message.tool_calls.map((call: any, index: number) => ({
          type: "tool_use",
          id: call.id,
          name: call.function.name,
          input: JSON.parse(call.function.arguments)
        })),
        model: openaiResponse.model,
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: openaiResponse.usage ? {
          input_tokens: openaiResponse.usage.prompt_tokens,
          output_tokens: openaiResponse.usage.completion_tokens
        } : undefined
      };
    }

    return {
      id: openaiResponse.id || `msg_${Date.now()}`,
      type: "message",
      role: "assistant",
      content: [{
        type: "text",
        text: choice.message?.content || ""
      }],
      model: openaiResponse.model,
      stop_reason: choice.finish_reason === "stop" ? "end_turn" : choice.finish_reason,
      stop_sequence: null,
      usage: openaiResponse.usage ? {
        input_tokens: openaiResponse.usage.prompt_tokens,
        output_tokens: openaiResponse.usage.completion_tokens
      } : undefined
    };
  }
  
  return openaiResponse;
}

function convertOpenAIStreamToClaude(openaiChunk: any): any {
    if (openaiChunk.choices && openaiChunk.choices[0]) {
        const choice = openaiChunk.choices[0];
        const delta = choice.delta;

        if (delta?.tool_calls) {
            const toolCall = delta.tool_calls[0];
            if (toolCall.index === 0 && toolCall.id) {
                return {
                    type: "content_block_start",
                    index: toolCall.index,
                    content_block: {
                        type: "tool_use",
                        id: toolCall.id,
                        name: toolCall.function.name,
                        input: {}
                    }
                };
            }
        }
        
        if (delta?.tool_calls?.[0]?.function?.arguments) {
            return {
                type: "content_block_delta",
                index: delta.tool_calls[0].index,
                delta: {
                    type: "input_json_delta",
                    partial_json: delta.tool_calls[0].function.arguments
                }
            };
        }

        if (delta?.content) {
            return {
                type: "content_block_delta",
                index: 0,
                delta: {
                    type: "text_delta",
                    text: delta.content
                }
            };
        }
    }
    return null;
}

// --- Deno Deploy 请求处理器 (更新为使用负载均衡) ---
async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key, anthropic-version"
      }
    });
  }

  if (url.pathname === "/health") {
    const stats = keyManager.getStats();
    return new Response(JSON.stringify({
      status: "OK",
      keyStats: stats,
      timestamp: new Date().toISOString()
    }), { 
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  if (url.pathname === "/v1/messages" && request.method === "POST") {
    // 验证Bearer token
    if (!validateBearerToken(request)) {
      return new Response(JSON.stringify({
        error: {
          type: "authentication_error",
          message: "Invalid or missing Bearer token"
        }
      }), {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

    try {
      const claudeRequest: ClaudeRequest = await request.json();
      console.log("Received Claude request:", JSON.stringify(claudeRequest, null, 2));
      
      const openaiRequest = convertClaudeToOpenAI(claudeRequest);
      console.log("Converted to OpenAI request:", JSON.stringify(openaiRequest, null, 2));

      // 使用带重试机制的请求函数
      const response = await makeRequestWithRetry(openaiRequest);

      if (!response.ok) {
        return response; // 已经在 makeRequestWithRetry 中处理过错误响应
      }

      if (claudeRequest.stream) {
        const reader = response.body?.getReader();
        if (!reader) throw new Error("Response body is not readable");

        const stream = new ReadableStream({
          async start(controller) {
            const decoder = new TextDecoder();
            let buffer = "";
            let toolCallStarted = false;
            let streamClosed = false;

            // 安全的enqueue函数，检查流状态
            const safeEnqueue = (data: Uint8Array) => {
              try {
                if (!streamClosed) {
                  controller.enqueue(data);
                }
              } catch (error) {
                console.error("Error enqueueing data:", error);
                streamClosed = true;
              }
            };

            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || "";

                for (const line of lines) {
                  if (streamClosed) break;
                  
                  if (line.trim().startsWith('data: ')) {
                    const dataStr = line.trim().substring(5).trim();
                    if (dataStr === '[DONE]') continue;
                    
                    try {
                      const openaiChunk = JSON.parse(dataStr);
                      const claudeEvent = convertOpenAIStreamToClaude(openaiChunk);
                      
                      if (claudeEvent && !streamClosed) {
                         if (claudeEvent.type === 'content_block_start' && !toolCallStarted) {
                            safeEnqueue(new TextEncoder().encode(`event: message_start\ndata: ${JSON.stringify({type: "message", message: {id: openaiChunk.id, type: "message", role: "assistant", content: [], model: openaiChunk.model, stop_reason: null, stop_sequence: null, usage: {input_tokens: 0, output_tokens: 0}}})}\n\n`));
                            toolCallStarted = true;
                         }

                        if (!streamClosed) {
                          safeEnqueue(new TextEncoder().encode(`event: ${claudeEvent.type === 'content_block_start' || claudeEvent.type === 'content_block_delta' ? 'content_block_delta' : 'message_delta'}\ndata: ${JSON.stringify(claudeEvent)}\n\n`));
                        }
                      }
                    } catch (e) {
                      console.error("Error parsing stream chunk:", dataStr, e);
                      // 继续处理其他chunks，不要因为一个解析错误就停止整个流
                    }
                  }
                }
                
                if (streamClosed) break;
              }
              
              // 发送结束信号
              if (!streamClosed) {
                const stopEvent = { type: "message_stop", "anthropic-internal-tool-use-end": toolCallStarted };
                safeEnqueue(new TextEncoder().encode(`event: message_stop\ndata: ${JSON.stringify(stopEvent)}\n\n`));
              }
            } catch (error) {
              console.error("Stream processing error:", error);
              if (!streamClosed) {
                try {
                  controller.error(error);
                } catch (e) {
                  console.error("Error setting controller error:", e);
                }
                streamClosed = true;
              }
            } finally {
              if (!streamClosed) {
                try {
                  controller.close();
                } catch (e) {
                  console.error("Error closing controller:", e);
                }
              }
            }
          }
        });

        return new Response(stream, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "Access-Control-Allow-Origin": "*"
          }
        });
      } else {
        const openaiResponse = await response.json();
        console.log("Received OpenAI response:", JSON.stringify(openaiResponse, null, 2));
        
        const claudeResponse = convertOpenAIToClaude(openaiResponse);
        console.log("Converted to Claude response:", JSON.stringify(claudeResponse, null, 2));

        return new Response(JSON.stringify(claudeResponse), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*"
          }
        });
      }
    } catch (error) {
      console.error("Error:", error);
      const stats = keyManager.getStats();
      console.log("Current key stats:", stats);
      
      return new Response(JSON.stringify({ 
        error: { 
          type: "proxy_error", 
          message: `Proxy error: ${error.message}`,
          keyStats: stats
        } 
      }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }
  }

  return new Response("Not Found. Use /v1/messages for API calls.", { status: 404 });
}

// --- Deno Deploy Export ---
export default {
  fetch: handleRequest,
};
