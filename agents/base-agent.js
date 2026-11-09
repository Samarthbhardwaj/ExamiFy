/**
 * BaseAgent — Standard interface for all Paper Simulator agents.
 * Every agent extends this class and implements validate() + execute().
 */
export class BaseAgent {
  constructor(name, config = {}) {
    this.name = name;
    this.config = config;
  }

  /**
   * Validate the input data contract before execution.
   * @param {object} input — The input payload
   * @returns {{ valid: boolean, errors: string[] }}
   */
  validate(input) {
    throw new Error(`${this.name}: validate() not implemented`);
  }

  /**
   * Execute the agent's core logic.
   * @param {object} input — The validated input payload
   * @returns {object} — The output data contract
   */
  execute(input) {
    throw new Error(`${this.name}: execute() not implemented`);
  }

  /**
   * Structured logging for agent activity.
   */
  log(message, level = 'info') {
    const ts = new Date().toISOString();
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    fn(`[${ts}] [${this.name}] ${message}`);
  }
}
