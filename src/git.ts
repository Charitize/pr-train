import difference = require('lodash.difference');
import { SimpleGit } from "simple-git/promise";
import { DEFAULT_REMOTE, MERGE_STEP_DELAY_WAIT_FOR_LOCK } from "./consts";
import { ExecFunction } from 'shelljs';
import emoji = require('node-emoji');
import { sleep } from "./sleep";


/**
 * Local git convenience wrapper around the SimpleGit client.
 */
export class GitClient {
  /**
   * @param sg SimpleGit client to manage local git operations.
   * @param shellJsExec Shell exec function to run commands on the shell.
   *                    Usually shelljs.exec.
   */
  constructor(private sg: SimpleGit, private shellJsExec: ExecFunction) {}

  /**
   * Returns `true` is ref `r1` is an ancestor of ref `r2`.
   *
   * @param r1 Git ref to check if is a parent/ancestor of r2.
   * @param r2 Git ref to check if is a child of r1.
   */
  public isBranchAncestor(r1: string, r2: string): boolean {
    return this.shellJsExec(`git merge-base --is-ancestor ${r1} ${r2}`).code === 0;
  }

  /**
   * Incorporates the changes in `from` branch into the `to` branch.
   *
   * If rebase is specified, `to` is rebased on top of `from`. Otherwise, a merge
   * commit from the `from` branch is merged into the `to` branch.
   *

   * @param rebase Requests branch incorporation by rebase, otherwise by merge.
   * @param from The branch to incorporate changes from, by rebased onto or merging
   *             from.
   * @param to The branch to incorporate the changes into, by rebasing onto the
   *           from branch or merging into from the from branch.
   */
  public async combineBranches(rebase: boolean, from: string, to: string) {
    if (rebase) {
      process.stdout.write(`rebasing ${to} onto branch ${from}... `);
    } else {
      process.stdout.write(`merging ${from} into branch ${to}... `);
    }
    try {
      await this.sg.checkout(to);
      await (rebase ? this.sg.rebase([from]) : this.sg.merge([from]));
    } catch (e) {
      if (!e.conflicts || e.conflicts.length === 0) {
        await sleep(MERGE_STEP_DELAY_WAIT_FOR_LOCK);
        await this.sg.checkout(to);
        await (rebase ? this.sg.rebase([from]) : this.sg.merge([from]));
      }
    }
    console.log(emoji.get('white_check_mark'));
  }

  /**
   * Pushes all git branches to remotes.
   *
   * @param branches The list of branches to push.
   * @param forcePush If the branch should be force pushed if it conflicts with
   *                  the remote.
   * @param remote The remote to push to. Defaults to origin.
   */
  public async pushBranches(branches: string[], forcePush: boolean,
                            remote: string = DEFAULT_REMOTE) {
    console.log(`Pushing changes to remote ${remote}...`);
    const args = [
      'push',
      ...(forcePush ? ['--force'] : []),
      remote
    ].concat(branches);
    // `raw` doesn't allow empty strings, so let's filter any "empty" args.
    await this.sg.raw(args.filter(Boolean));
    console.log('All changes pushed ' + emoji.get('white_check_mark'));
  }

  /**
   * Gets the branches not merged into stableBranch.
   *
   * @param branches The branches to check.
   * @param stableBranch The branch to check if branches have been merged into.
   * @return All branches not yet merged into stableBranch.
   */
  public async getUnmergedBranches(
      branches: string[], stableBranch: string): Promise<string[]> {
    const mergedBranchesOutput =
        await this.sg.raw(['branch', '--merged', stableBranch]);
    const mergedBranches = mergedBranchesOutput
      .split('\n')
      .map(b => b.trim())
      .filter(Boolean);
    return difference(branches, mergedBranches);
  }
}
