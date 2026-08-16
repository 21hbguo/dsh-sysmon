/**
 * Invariant companion for @dsh-external/dsh-sysmon.
 *
 * No runtime invariant: the plugin owns one HTTP route (webServer.register)
 * whose disposer is exercised on fiber disposal — route presence is not an
 * event/data relationship, so there is nothing to assert at load time.
 * @module @dsh-external/dsh-sysmon/invariant
 */

/** Provides no assertions: sysmon owns no cross-package runtime invariants. */
export function apply(): void {}
