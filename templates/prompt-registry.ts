/**
 * prompt-registry.ts
 *
 * In-memory prompt registry with optional file-system persistence and
 * weighted A/B variant selection.
 *
 * - `register()`     adds or replaces an entry by id+version
 * - `getActive(id)`  returns the active entry for an id
 * - `getVersion(id, version)` returns a specific entry
 * - `setActive(id, version)`  promotes a version to active (only one active per id)
 * - `getABVariant(id)` returns a weighted-random entry across non-zero weights
 *
 * Persistence is optional: pass `{ persistencePath }` to read on construction
 * and write after every mutation. The on-disk format is plain JSON.
 */

import { promises as fs } from "fs";
import * as path from "path";

/** A single registry entry — one (id, version) pair. */
export interface PromptEntry {
  /** Logical prompt identifier, stable across versions. */
  id: string;
  /** Semver string (e.g. "1.0.0", "2.1.3"). */
  version: string;
  /** The prompt text itself. */
  content: string;
  /** Unix ms — set by `register()` if not provided. */
  createdAt: number;
  /** Only one entry per id may be active at a time. */
  isActive: boolean;
  /** Weight used by `getABVariant()`. 0 = excluded from A/B. */
  abTestWeight: number;
}

/** Options for `PromptRegistry`. */
export interface PromptRegistryOptions {
  /** Optional path to a JSON file. If set, reads on `load()` and writes on every mutation. */
  persistencePath?: string;
  /** Random source — override in tests for determinism. Default: Math.random. */
  random?: () => number;
}

/** Thrown when a registry operation cannot find the requested entry. */
export class PromptNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptNotFoundError";
  }
}

/**
 * Versioned prompt store.
 *
 * @example
 *   const registry = new PromptRegistry({ persistencePath: "./prompts.json" });
 *   await registry.load();
 *   registry.register({ id: "triage", version: "1.0.0", content: "...", abTestWeight: 1, isActive: true });
 *   const { content } = registry.getActive("triage");
 */
export class PromptRegistry {
  /** id → version → entry */
  private store: Map<string, Map<string, PromptEntry>> = new Map();
  private readonly random: () => number;

  constructor(private readonly options: PromptRegistryOptions = {}) {
    this.random = options.random ?? Math.random;
  }

  /** Load from `persistencePath` if configured. Safe to call when the file is missing. */
  async load(): Promise<void> {
    if (!this.options.persistencePath) return;
    try {
      const raw = await fs.readFile(this.options.persistencePath, "utf8");
      const parsed = JSON.parse(raw) as PromptEntry[];
      this.store.clear();
      for (const entry of parsed) this.insert(entry);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      // Missing file is fine — registry starts empty.
    }
  }

  /**
   * Add or replace an entry. If `isActive` is true, all other versions of
   * the same id are demoted. `createdAt` defaults to `Date.now()`.
   */
  register(entry: Omit<PromptEntry, "createdAt"> & { createdAt?: number }): PromptEntry {
    const full: PromptEntry = {
      ...entry,
      createdAt: entry.createdAt ?? Date.now(),
    };
    if (full.isActive) this.demoteOthers(full.id);
    this.insert(full);
    void this.persist();
    return full;
  }

  /** Return the active entry for an id, or throw. */
  getActive(id: string): PromptEntry {
    const versions = this.store.get(id);
    if (!versions) throw new PromptNotFoundError(`No prompts registered for id "${id}".`);
    for (const entry of versions.values()) {
      if (entry.isActive) return entry;
    }
    throw new PromptNotFoundError(`No active version for prompt id "${id}".`);
  }

  /** Return a specific (id, version) entry, or throw. */
  getVersion(id: string, version: string): PromptEntry {
    const entry = this.store.get(id)?.get(version);
    if (!entry) {
      throw new PromptNotFoundError(`No entry for prompt "${id}" version "${version}".`);
    }
    return entry;
  }

  /** Promote a version to active, demoting all others for the same id. */
  setActive(id: string, version: string): PromptEntry {
    const target = this.getVersion(id, version);
    this.demoteOthers(id);
    target.isActive = true;
    void this.persist();
    return target;
  }

  /**
   * Pick a weighted-random variant for an id. Only entries with
   * `abTestWeight > 0` participate. Throws if no eligible entries exist.
   */
  getABVariant(id: string): PromptEntry {
    const versions = this.store.get(id);
    if (!versions) throw new PromptNotFoundError(`No prompts registered for id "${id}".`);

    const eligible = [...versions.values()].filter((e) => e.abTestWeight > 0);
    if (eligible.length === 0) {
      throw new PromptNotFoundError(`No A/B-eligible variants for prompt id "${id}".`);
    }

    const total = eligible.reduce((sum, e) => sum + e.abTestWeight, 0);
    let pick = this.random() * total;
    for (const entry of eligible) {
      pick -= entry.abTestWeight;
      if (pick <= 0) return entry;
    }
    return eligible[eligible.length - 1]!;
  }

  /** All entries for a single id (any order). */
  listVersions(id: string): PromptEntry[] {
    const versions = this.store.get(id);
    return versions ? [...versions.values()] : [];
  }

  /** All entries across all ids (any order). */
  list(): PromptEntry[] {
    const out: PromptEntry[] = [];
    for (const versions of this.store.values()) {
      for (const entry of versions.values()) out.push(entry);
    }
    return out;
  }

  /* -------------------------------------------------------------------- */
  /* internals                                                            */
  /* -------------------------------------------------------------------- */

  private insert(entry: PromptEntry): void {
    let versions = this.store.get(entry.id);
    if (!versions) {
      versions = new Map();
      this.store.set(entry.id, versions);
    }
    versions.set(entry.version, entry);
  }

  private demoteOthers(id: string): void {
    const versions = this.store.get(id);
    if (!versions) return;
    for (const entry of versions.values()) entry.isActive = false;
  }

  private async persist(): Promise<void> {
    if (!this.options.persistencePath) return;
    const payload = JSON.stringify(this.list(), null, 2);
    const dir = path.dirname(this.options.persistencePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.options.persistencePath, payload, "utf8");
  }
}
