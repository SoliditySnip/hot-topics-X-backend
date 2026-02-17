/**
 * API Key Pool Manager
 * 
 * Production-grade key rotation system for Rettiwt API keys.
 * 
 * Features:
 * - Round-robin rotation across all available keys
 * - Automatic cooldown on rate-limited keys (15 min default)
 * - Health tracking per key (success/fail counters, last used time)
 * - Smart key selection: skips keys that are cooling down
 * - Retry with next available key on rate limit errors
 * - Exponential backoff when all keys are exhausted
 * - Status reporting for monitoring/debugging
 */

import { Rettiwt } from 'rettiwt-api';

// ============================================================
// TYPES
// ============================================================

interface KeyState {
    key: string;
    index: number;
    instance: Rettiwt;

    // Health tracking
    totalRequests: number;
    successCount: number;
    failCount: number;
    rateLimitHits: number;

    // Cooldown
    cooldownUntil: number;  // timestamp (0 = not cooling down)
    lastUsedAt: number;
    lastErrorAt: number;
    lastError: string | null;

    // Status
    isHealthy: boolean;
}

export interface KeyPoolStats {
    totalKeys: number;
    healthyKeys: number;
    coolingDownKeys: number;
    currentIndex: number;
    keys: Array<{
        index: number;
        maskedKey: string;
        isHealthy: boolean;
        isCoolingDown: boolean;
        cooldownRemainingSec: number;
        totalRequests: number;
        successRate: string;
        rateLimitHits: number;
        lastUsedAgo: string;
    }>;
}

// ============================================================
// CONFIG
// ============================================================

const RATE_LIMIT_COOLDOWN_MS = 15 * 60 * 1000;   // 15 minutes cooldown after rate limit
const ERROR_COOLDOWN_MS = 2 * 60 * 1000;          // 2 min cooldown after generic error
const MAX_CONSECUTIVE_FAILS = 5;                    // Mark key unhealthy after 5 consecutive fails
const ALL_KEYS_EXHAUSTED_WAIT_MS = 30 * 1000;      // Wait 30s if all keys are cooling down
const REQUEST_DELAY_MS = 1500;                      // 1.5s delay between requests on same key

// ============================================================
// KEY POOL MANAGER
// ============================================================

class KeyPoolManager {
    private keys: KeyState[] = [];
    private currentIndex: number = 0;
    private initialized: boolean = false;
    private consecutiveAllExhausted: number = 0;

    /**
     * Initialize the pool with comma-separated API keys.
     */
    initialize(apiKeys: string): void {
        if (this.initialized) return;

        const keyList = apiKeys
            .split(',')
            .map(k => k.trim())
            .filter(k => k.length > 0);

        if (keyList.length === 0) {
            throw new Error(
                'No RETTIWT_API_KEYS found. Set them in .env as comma-separated values.'
            );
        }

        this.keys = keyList.map((key, index) => ({
            key,
            index,
            instance: new Rettiwt({ apiKey: key, logging: false }),
            totalRequests: 0,
            successCount: 0,
            failCount: 0,
            rateLimitHits: 0,
            cooldownUntil: 0,
            lastUsedAt: 0,
            lastErrorAt: 0,
            lastError: null,
            isHealthy: true,
        }));

        this.initialized = true;
        console.log(`[KEY POOL] Initialized with ${this.keys.length} API keys`);
        this.keys.forEach((k, i) => {
            console.log(`  Key #${i + 1}: ${this.maskKey(k.key)} ✅`);
        });
    }

    /**
     * Execute a function with automatic key rotation and retry.
     * If the current key hits a rate limit, it tries the next one.
     */
    async execute<T>(
        operation: (rettiwt: Rettiwt) => Promise<T>,
        operationName: string = 'request'
    ): Promise<T> {
        if (!this.initialized || this.keys.length === 0) {
            throw new Error('Key pool not initialized. Call initialize() first.');
        }

        const triedKeys = new Set<number>();

        while (triedKeys.size < this.keys.length) {
            const keyState = this.getNextAvailableKey(triedKeys);

            if (!keyState) {
                // All keys are either tried or cooling down
                const nextAvailableIn = this.getNextCooldownEnd();
                if (nextAvailableIn > 0) {
                    const waitTime = Math.min(nextAvailableIn, ALL_KEYS_EXHAUSTED_WAIT_MS);
                    this.consecutiveAllExhausted++;
                    console.warn(
                        `[KEY POOL] ⏳ All keys cooling down. Waiting ${Math.round(waitTime / 1000)}s... ` +
                        `(attempt ${this.consecutiveAllExhausted})`
                    );
                    await this.sleep(waitTime);

                    // Reset tried keys and try again
                    triedKeys.clear();
                    continue;
                }
                break;
            }

            triedKeys.add(keyState.index);

            try {
                // Enforce minimum delay between requests on same key
                const timeSinceLastUse = Date.now() - keyState.lastUsedAt;
                if (timeSinceLastUse < REQUEST_DELAY_MS && keyState.lastUsedAt > 0) {
                    await this.sleep(REQUEST_DELAY_MS - timeSinceLastUse);
                }

                keyState.lastUsedAt = Date.now();
                keyState.totalRequests++;

                const result = await operation(keyState.instance);

                // Success!
                keyState.successCount++;
                keyState.isHealthy = true;
                keyState.failCount = 0; // Reset consecutive fails
                this.consecutiveAllExhausted = 0;

                console.log(
                    `[KEY POOL] ✅ ${operationName} succeeded with Key #${keyState.index + 1} ` +
                    `(${keyState.successCount}/${keyState.totalRequests} success)`
                );

                return result;

            } catch (error: any) {
                const isRateLimit = this.isRateLimitError(error);
                keyState.lastErrorAt = Date.now();
                keyState.lastError = error.message || String(error);

                if (isRateLimit) {
                    // Rate limit — put key on cooldown
                    keyState.rateLimitHits++;
                    keyState.cooldownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;

                    console.warn(
                        `[KEY POOL] 🔴 Key #${keyState.index + 1} rate limited! ` +
                        `Cooling down for ${RATE_LIMIT_COOLDOWN_MS / 60000} min. ` +
                        `(Total rate limits: ${keyState.rateLimitHits}). Trying next key...`
                    );
                } else {
                    // Other error — shorter cooldown
                    keyState.failCount++;
                    keyState.cooldownUntil = Date.now() + ERROR_COOLDOWN_MS;

                    if (keyState.failCount >= MAX_CONSECUTIVE_FAILS) {
                        keyState.isHealthy = false;
                        console.error(
                            `[KEY POOL] ❌ Key #${keyState.index + 1} marked UNHEALTHY ` +
                            `after ${keyState.failCount} consecutive fails: ${error.message}`
                        );
                    } else {
                        console.warn(
                            `[KEY POOL] ⚠️ Key #${keyState.index + 1} failed: ${error.message}. ` +
                            `Trying next key...`
                        );
                    }
                }

                // Try the next key
                continue;
            }
        }

        // All keys failed
        throw new Error(
            `[KEY POOL] All ${this.keys.length} keys exhausted for "${operationName}". ` +
            `Check your API keys and rate limits.`
        );
    }

    /**
     * Get pool status for monitoring/debugging.
     */
    getStats(): KeyPoolStats {
        const now = Date.now();
        return {
            totalKeys: this.keys.length,
            healthyKeys: this.keys.filter(k => k.isHealthy && !this.isCoolingDown(k)).length,
            coolingDownKeys: this.keys.filter(k => this.isCoolingDown(k)).length,
            currentIndex: this.currentIndex,
            keys: this.keys.map(k => ({
                index: k.index,
                maskedKey: this.maskKey(k.key),
                isHealthy: k.isHealthy,
                isCoolingDown: this.isCoolingDown(k),
                cooldownRemainingSec: this.isCoolingDown(k)
                    ? Math.round((k.cooldownUntil - now) / 1000)
                    : 0,
                totalRequests: k.totalRequests,
                successRate: k.totalRequests > 0
                    ? `${Math.round((k.successCount / k.totalRequests) * 100)}%`
                    : 'N/A',
                rateLimitHits: k.rateLimitHits,
                lastUsedAgo: k.lastUsedAt > 0
                    ? `${Math.round((now - k.lastUsedAt) / 1000)}s ago`
                    : 'never',
            })),
        };
    }

    /**
     * Force reset a specific key's cooldown (e.g., from admin API).
     */
    resetKey(index: number): void {
        const key = this.keys[index];
        if (key) {
            key.cooldownUntil = 0;
            key.failCount = 0;
            key.isHealthy = true;
            console.log(`[KEY POOL] Key #${index + 1} manually reset`);
        }
    }

    /**
     * Force reset ALL keys' cooldown.
     */
    resetAll(): void {
        this.keys.forEach(k => {
            k.cooldownUntil = 0;
            k.failCount = 0;
            k.isHealthy = true;
        });
        this.consecutiveAllExhausted = 0;
        console.log(`[KEY POOL] All ${this.keys.length} keys reset`);
    }

    // —— Private helpers ——

    /**
     * Select the next available key using round-robin,
     * skipping keys that are cooling down or unhealthy.
     */
    private getNextAvailableKey(triedKeys: Set<number>): KeyState | null {
        const startIndex = this.currentIndex;

        for (let attempt = 0; attempt < this.keys.length; attempt++) {
            const idx = (startIndex + attempt) % this.keys.length;
            const key = this.keys[idx];

            if (triedKeys.has(idx)) continue;
            if (!key.isHealthy) continue;
            if (this.isCoolingDown(key)) continue;

            // Found a usable key — advance the index for next call
            this.currentIndex = (idx + 1) % this.keys.length;
            return key;
        }

        return null;
    }

    private isCoolingDown(key: KeyState): boolean {
        return key.cooldownUntil > Date.now();
    }

    private getNextCooldownEnd(): number {
        const now = Date.now();
        const coolingKeys = this.keys.filter(k => k.cooldownUntil > now);
        if (coolingKeys.length === 0) return 0;

        const earliest = Math.min(...coolingKeys.map(k => k.cooldownUntil));
        return earliest - now;
    }

    private isRateLimitError(error: any): boolean {
        const message = (error.message || '').toLowerCase();
        const code = error.code;

        return (
            message.includes('rate limit') ||
            message.includes('too many requests') ||
            code === 88 ||   // Twitter rate limit error code
            code === 429
        );
    }

    private maskKey(key: string): string {
        if (key.length <= 12) return '***';
        return key.substring(0, 6) + '...' + key.substring(key.length - 6);
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// Singleton instance
export const keyPool = new KeyPoolManager();
