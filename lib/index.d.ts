import type { Context } from 'cordis';

export declare const name: 'dsh-wait-guard';
export declare const inject: ['tools'];
export interface WaitGuardConfig {
  perCallMaxMs?: number;
  youngMs?: number;
  totalBudgetMs?: number;
  defaultWaitMs?: number;
  slowProgramMs?: number;
  programDeadlineMs?: number;
  probeLimit?: number;
  probeWindowMs?: number;
  noopLimit?: number;
}
export declare function apply(ctx: Context, config?: WaitGuardConfig): void;
