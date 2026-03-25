/**
 * Fallback chain for brcc
 * Automatically switches to backup models when primary fails (429, 5xx, etc.)
 */

export interface FallbackConfig {
  /** Models to try in order of priority */
  chain: string[];
  /** HTTP status codes that trigger fallback */
  retryOn: number[];
  /** Maximum retries across all models */
  maxRetries: number;
  /** Delay between retries in ms */
  retryDelayMs: number;
}

export const DEFAULT_FALLBACK_CONFIG: FallbackConfig = {
  chain: [
    'blockrun/auto', // Smart routing (default)
    'blockrun/eco', // Cheapest capable model
    'deepseek/deepseek-chat', // Direct fallback
    'nvidia/gpt-oss-120b', // Free model as ultimate fallback
  ],
  retryOn: [429, 500, 502, 503, 504, 529],
  maxRetries: 5,
  retryDelayMs: 1000,
};

export interface FallbackResult {
  response: Response;
  modelUsed: string;
  fallbackUsed: boolean;
  attemptsCount: number;
  failedModels: string[];
}

/**
 * Sleep helper
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Replace model in request body
 */
function replaceModelInBody(body: string, newModel: string): string {
  try {
    const parsed = JSON.parse(body);
    parsed.model = newModel;
    return JSON.stringify(parsed);
  } catch {
    return body;
  }
}

/**
 * Fetch with automatic fallback to backup models
 */
export async function fetchWithFallback(
  url: string,
  init: RequestInit,
  originalBody: string,
  config: FallbackConfig = DEFAULT_FALLBACK_CONFIG,
  onFallback?: (model: string, statusCode: number, nextModel: string) => void
): Promise<FallbackResult> {
  const failedModels: string[] = [];
  let attempts = 0;

  for (let i = 0; i < config.chain.length && attempts < config.maxRetries; i++) {
    const model = config.chain[i];
    const body = replaceModelInBody(originalBody, model);

    try {
      attempts++;
      const response = await fetch(url, {
        ...init,
        body,
      });

      // Success or non-retryable error
      if (!config.retryOn.includes(response.status)) {
        return {
          response,
          modelUsed: model,
          fallbackUsed: i > 0,
          attemptsCount: attempts,
          failedModels,
        };
      }

      // Retryable error - log and try next
      failedModels.push(model);
      const nextModel = config.chain[i + 1];

      if (nextModel && onFallback) {
        onFallback(model, response.status, nextModel);
      }

      // Wait before trying next model (with exponential backoff for same model retries)
      if (i < config.chain.length - 1) {
        await sleep(config.retryDelayMs);
      }
    } catch (err) {
      // Network error - try next model
      failedModels.push(model);
      const nextModel = config.chain[i + 1];

      if (nextModel && onFallback) {
        const errMsg = err instanceof Error ? err.message : 'Network error';
        onFallback(model, 0, nextModel);
        console.error(`[fallback] ${model} network error: ${errMsg}`);
      }

      if (i < config.chain.length - 1) {
        await sleep(config.retryDelayMs);
      }
    }
  }

  // All models failed - throw error
  throw new Error(
    `All models in fallback chain failed: ${failedModels.join(', ')}`
  );
}

/**
 * Get the current model from fallback chain based on parsed request
 */
export function getCurrentModelFromChain(
  requestedModel: string | undefined,
  config: FallbackConfig = DEFAULT_FALLBACK_CONFIG
): string {
  // If model is explicitly set and in chain, start from there
  if (requestedModel) {
    const index = config.chain.indexOf(requestedModel);
    if (index >= 0) {
      return requestedModel;
    }
    // Model not in chain, use as-is (user specified custom model)
    return requestedModel;
  }
  // Default to first model in chain
  return config.chain[0];
}

// Provider-aware fallbacks for explicit model requests
const PROVIDER_FALLBACKS: Record<string, string[]> = {
  'anthropic': ['anthropic/claude-sonnet-4.6', 'anthropic/claude-haiku-4.5'],
  'openai': ['openai/gpt-5.4', 'openai/gpt-5-mini'],
  'google': ['google/gemini-2.5-pro', 'google/gemini-2.5-flash'],
  'deepseek': ['deepseek/deepseek-chat'],
  'xai': ['xai/grok-3', 'xai/grok-4-fast'],
};

/**
 * Build fallback chain starting from a specific model
 */
export function buildFallbackChain(
  startModel: string,
  config: FallbackConfig = DEFAULT_FALLBACK_CONFIG
): string[] {
  const index = config.chain.indexOf(startModel);
  if (index >= 0) {
    // Start from this model and include all after it
    return config.chain.slice(index);
  }

  // Model not in default chain - build provider-aware fallback
  const provider = startModel.split('/')[0];
  const providerFallbacks = PROVIDER_FALLBACKS[provider] || [];
  
  // Filter to models after the requested one in provider's list
  const startIdx = providerFallbacks.indexOf(startModel);
  const sameFamilyFallbacks = startIdx >= 0 
    ? providerFallbacks.slice(startIdx + 1)
    : providerFallbacks.filter(m => m !== startModel);

  // Chain: requested model → same provider fallbacks → free model (skip smart routing)
  return [startModel, ...sameFamilyFallbacks, 'nvidia/gpt-oss-120b'];
}
