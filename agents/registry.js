/**
 * AgentRegistry — Central registry for agent discovery and pipeline management.
 * Agents register themselves here; the Orchestrator queries the registry
 * to build and run the processing pipeline.
 */
export class AgentRegistry {
  constructor() {
    /** @type {Map<string, import('./base-agent.js').BaseAgent>} */
    this.agents = new Map();

    /** @type {{ name: string, position: number }[]} */
    this.pipeline = [];
  }

  /**
   * Register an agent instance under a unique name.
   * @param {string} name — Unique identifier for the agent
   * @param {import('./base-agent.js').BaseAgent} agent — The agent instance
   * @param {number} [position] — Pipeline ordering (lower = earlier). Optional.
   */
  register(name, agent, position = null) {
    if (this.agents.has(name)) {
      this.agents.set(name, agent);
      return;
    }
    this.agents.set(name, agent);
    if (position !== null) {
      this.pipeline.push({ name, position });
      this.pipeline.sort((a, b) => a.position - b.position);
    }
  }

  /**
   * Retrieve an agent by name.
   * @param {string} name
   * @returns {import('./base-agent.js').BaseAgent}
   */
  get(name) {
    const agent = this.agents.get(name);
    if (!agent) throw new Error(`Agent "${name}" not found in registry.`);
    return agent;
  }

  /**
   * Check if an agent is registered.
   */
  has(name) {
    return this.agents.has(name);
  }

  /**
   * Return the ordered pipeline of agent names.
   * @returns {string[]}
   */
  getPipeline() {
    return this.pipeline.map(p => p.name);
  }

  /**
   * List all registered agent names.
   * @returns {string[]}
   */
  listAll() {
    return Array.from(this.agents.keys());
  }
}

// Singleton registry instance
export const registry = new AgentRegistry();
