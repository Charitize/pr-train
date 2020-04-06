/** Local git convenience methods around the SimpleGit client. */

import difference = require('lodash.difference');
import { SimpleGit } from "simple-git/promise";
import { DEFAULT_REMOTE, MERGE_STEP_DELAY_WAIT_FOR_LOCK } from "./consts";
import shelljs = require('shelljs');
import emoji = require('node-emoji');
import { sleep } from "./sleep";

/**
 * Returns `true` is ref `r1` is an ancestor of ref `r2`.
 *
 * @param r1 Git ref to check if is a parent/ancestor of r2.
 * @param r2 Git ref to check if is a child of r1.
 */
export function isBranchAncestor(r1: string, r2: string): boolean {
  return shelljs.exec(`git merge-base --is-ancestor ${r1} ${r2}`).code === 0;
}

/**
 * Incorporates the changes in `from` branch into the `to` branch.
 *
 * If rebase is specified, `to` is rebased on top of `from`. Otherwise, a merge
 * commit from the `from` branch is merged into the `to` branch.
 *
 * @param sg SimpleGit client to manage local git operations.
 * @param rebase Requests branch incorporation by rebase, otherwise by merge.
 * @param from The branch to incorporate changes from, by rebased onto or merging
 *             from.
 * @param to The branch to incorporate the changes into, by rebasing onto the
 *           from branch or merging into from the from branch.
 */
export async function combineBranches(sg: SimpleGit, rebase: boolean, from: string,
                               to: string) {
  if (rebase) {
    process.stdout.write(`rebasing ${to} onto branch ${from}... `);
  } else {
    process.stdout.write(`merging ${from} into branch ${to}... `);
  }
  try {
    await sg.checkout(to);
    await (rebase ? sg.rebase([from]) : sg.merge([from]));
  } catch (e) {
    if (!e.conflicts || e.conflicts.length === 0) {
      await sleep(MERGE_STEP_DELAY_WAIT_FOR_LOCK);
      await sg.checkout(to);
      await (rebase ? sg.rebase([from]) : sg.merge([from]));
    }
  }
  console.log(emoji.get('white_check_mark'));
}

/**
 * Pushes all git branches to remotes.
 *
 * @param sg SimpleGit to perform local git operations with.
 * @param branches The list of branches to push.
 * @param forcePush If the branch should be force pushed if it conflicts with
 *                  the remote.
 * @param remote The remote to push to. Defaults to origin.
 */
export async function pushBranches(
    sg: SimpleGit, branches: string[], forcePush: boolean,
    remote: string = DEFAULT_REMOTE) {
  console.log(`Pushing changes to remote ${remote}...`);
  const args = [
    'push',
    ...(forcePush ? ['--force'] : []),
    remote
  ].concat(branches);
  // `raw` doesn't allow empty strings, so let's filter any "empty" args.
  await sg.raw(args.filter(Boolean));
  console.log('All changes pushed ' + emoji.get('white_check_mark'));
}

/**
 * Gets the branches not merged into master.
 *
 * @param sg SimpleGit client to perform local git operations with.
 * @param branches The branches to check.
 * @return All branches not yet merged into master.
 */
export async function getUnmergedBranches(
    sg: SimpleGit, branches: string[]): Promise<string[]> {
  const mergedBranchesOutput = await sg.raw(['branch', '--merged', 'master']);
  const mergedBranches = mergedBranchesOutput
    .split('\n')
    .map(b => b.trim())
    .filter(Boolean);
  return difference(branches, mergedBranches);
}
