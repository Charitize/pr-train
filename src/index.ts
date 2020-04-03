
// @ts-check
import simpleGit = require('simple-git/promise');
import difference = require('lodash.difference');
import { createCommand } from 'commander';
import emoji = require('node-emoji');
import fs = require('fs');
import yaml = require('js-yaml');
import { ensurePrsExist, checkGHKeyExists } from './github';
import colors = require('colors');
import { DEFAULT_REMOTE, MERGE_STEP_DELAY_MS, MERGE_STEP_DELAY_WAIT_FOR_LOCK } from './consts';
import path = require('path');
// @ts-ignore
import packageFile = require('../package.json');
import inquirer = require('inquirer');
import shelljs = require('shelljs');
import { SimpleGit } from "simple-git/promise";

/**
 * Creates a promise to block the process for the provided time.
 *
 * @param ms Number of milliseconds to sleep for.
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Returns `true` is ref `r1` is an ancestor of ref `r2`.
 *
 * @param r1 Git ref to check if is a parent/ancestor of r2.
 * @param r2 Git ref to check if is a child of r1.
 */
function isBranchAncestor(r1: string, r2: string): boolean {
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
async function combineBranches(sg: SimpleGit, rebase: boolean, from: string,
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
async function pushBranches(
    sg: SimpleGit, branches: string[], forcePush: boolean,
    remote: string = DEFAULT_REMOTE) {
  console.log(`Pushing changes to remote ${remote}...`);
  // Ugh... `raw` doesn't allow empty strings or `undefined`s, so let's filter any "empty" args.
  const args = ['push', forcePush ? '--force' : undefined, remote].concat(branches).filter(Boolean);
  await sg.raw(args);
  console.log('All changes pushed ' + emoji.get('white_check_mark'));
}

/**
 * Gets the branches not merged into master.
 *
 * @param sg SimpleGit client to perform local git operations with.
 * @param branches The branches to check.
 * @return All branches not yet merged into master.
 */
async function getUnmergedBranches(
    sg: SimpleGit, branches: string[]): Promise<string[]> {
  const mergedBranchesOutput = await sg.raw(['branch', '--merged', 'master']);
  const mergedBranches = mergedBranchesOutput
    .split('\n')
    .map(b => b.trim())
    .filter(Boolean);
  return difference(branches, mergedBranches);
}

/**
 * Gets the path of .pr-train.yml at the root of the repository.
 *
 * @param sg SimpleGit client to perform local git operations with.
 */
async function getConfigPath(sg): Promise<string> {
  const repoRootPath = (await sg.raw(['rev-parse', '--show-toplevel'])).trim();
  return `${repoRootPath}/.pr-train.yml`;
}

/**
 * @typedef {string | Object.<string, { combined: boolean, initSha?: string }>} BranchCfg
 * @typedef {Object.<string, Array.<string | BranchCfg>>} TrainCfg
 */

interface BranchConfig {
  [branchName: string]: {
    combined: boolean,
    initSha?: string,
  }
}

interface TrainConfig {
  [branchName: string]: (string | BranchConfig)[];
}

interface PRTrainConfig {
  trains: TrainConfig[];
}


/**
 * Gets the pr-train configuration from the .pr-train.yml file at the repository
 * root.
 *
 * @param sg SimpleGit client to get the configuration based on.
 * @return The PR Train configuration.
 */
async function loadConfig(sg): Promise<PRTrainConfig> {
  const path = await getConfigPath(sg);
  return yaml.safeLoad(fs.readFileSync(path, 'utf8'));
}

/**
 * Gets the name of the branch configs tip branch name or otherwise if the
 * argument is a string, returns the branch.
 *
 * @param branchCfg The configuration of a branch or the branch name if provided
 *                  directly.
 */
function getBranchName(branchCfg: BranchConfig | string): string {
  return typeof branchCfg === 'string' ? branchCfg : Object.keys(branchCfg)[0];
}

/**
 * Gets the PR train branch configs for the branch currently checked out.
 *
 * @param sg SimpleGit client to look at the current branches.
 * @param config The entire PR train config for all PR trains.
 * @return The branch configurations for the currently checked out PR train.
 */
async function getBranchesConfigInCurrentTrain(
    sg: SimpleGit, config: PRTrainConfig): Promise<BranchConfig[] | null> {
  const branches = await sg.branchLocal();
  const currentBranch = branches.current;
  const { trains } = config;
  if (!trains) {
    return null;
  }
  const key = Object.keys(trains).find(trainKey => {
    const branches = trains[trainKey];
    const branchNames = branches.map(b => getBranchName(b));
    return branchNames.indexOf(currentBranch) >= 0;
  });
  return key && trains[key];
}

/**
 * Maps branch names for the provided branch configs.
 *
 * @param branchConfig The branch configs to get the names for.
 */
function getBranchesInCurrentTrain(branchConfig: BranchConfig[]): string[] {
  return branchConfig.map(b => getBranchName(b));
}

/**
 * For a series of branch configs in a train, finds the name of the tip branch.
 *
 * @param branchConfig The branches in a given train.
 * @return The branch at the tip of the configuration for a train.
 */
function getCombinedBranch(branchConfig: BranchConfig[]): string {
  const combinedBranch = /** @type {Object<string, {combined: boolean}>} */ branchConfig.find(cfg => {
    if (typeof cfg === 'string') {
      return false;
    }
    const branchName = Object.keys(cfg)[0];
    return cfg[branchName].combined;
  });
  if (!combinedBranch) {
    return undefined;
  }
  const branchName = Object.keys(combinedBranch)[0];
  return branchName;
}

/**
 * Switches the branch to the branch named as the first program argument.
 *
 * "combined" is handled specially to switch to the tip branch.
 *
 * @param sg SimpleGit client to checkout the requested branch.
 * @param sortedBranches The branches in the current PR train.
 * @param combinedBranch The name of the combined branch at the tip of the PR
 *                       train.
 */
async function handleSwitchToBranchCommand(
    sg: SimpleGit, sortedBranches: string[], combinedBranch: string,
    switchToBranchIndex: string | undefined) {
  if (typeof switchToBranchIndex === 'undefined') {
    return;
  }
  let targetBranch;
  if (switchToBranchIndex === 'combined') {
    targetBranch = combinedBranch;
  } else {
    targetBranch = sortedBranches[switchToBranchIndex];
  }
  if (!targetBranch) {
    console.log(`Could not find branch with index ${switchToBranchIndex}`.red);
    process.exit(3);
  }
  await sg.checkout(targetBranch);
  console.log(`Switched to branch ${targetBranch}`);
  process.exit(0);
}

async function initializePrTrain(sg: SimpleGit) {
  if (fs.existsSync(await getConfigPath(sg))) {
    console.log('.pr-train.yml already exists');
    process.exit(1);
  }
  const root = path.dirname(require.main.filename);
  const cfgTpl = fs.readFileSync(`${root}/cfg_template.yml`);
  fs.writeFileSync(await getConfigPath(sg), cfgTpl);
  console.log(`Created a ".pr-train.yml" file. Please make sure it's gitignored.`);
  return;
}

/**
 * Looks for the branches in the current train not yet merged into master and
 * pushes them.
 *
 * @param sg SimpleGit client to interact with local git repository.
 * @param sortedBranches The branches in the current PR train.
 * @param pushMerged If true, pushes branches even if merged into master.
 * @param force If the branch history differs from origin, force pushes.
 * @param remote The git remote to push to.
 */
async function findAndPushBranches(
    sg: SimpleGit, sortedBranches: string[],
    pushMerged: boolean, force: boolean, remote: string) {
  let branchesToPush = sortedBranches;
  if (!pushMerged) {
    branchesToPush = await getUnmergedBranches(sg, sortedBranches);
    const branchDiff = difference(sortedBranches, branchesToPush);
    if (branchDiff.length > 0) {
      console.log(`Not pushing already merged branches: ${branchDiff.join(', ')}`);
    }
  }
  pushBranches(sg, branchesToPush, force, remote);
}

async function printBranchesInTrain(
    sg: SimpleGit, sortedBranches: string[], currentBranch: string,
    combinedBranch: string, listBranches: boolean) {
  console.log(`I've found these partial branches:`);
  const branchesToPrint = sortedBranches.map((b, idx) => {
    const branch = b === currentBranch ? `${b.green.bold}` : b;
    const suffix = b === combinedBranch ? ' (combined)' : '';
    return `[${idx}] ${branch}${suffix}`;
  });

  if (listBranches) {
    const answer = await inquirer.prompt([
      {
        type: 'list',
        name: 'branch',
        message: 'Select a branch to checkout',
        choices: branchesToPrint.map((b, i) => ({ name: b, value: sortedBranches[i] })),
        pageSize: 20,
      },
    ]);
    console.log(`checking out branch ${answer.branch}`);
    await sg.checkout(answer.branch);
    return;
  }

  console.log(branchesToPrint.map(b => ` -> ${b}`).join('\n'), '\n');

}

async function main() {
  const program = createCommand();
  program
    .version(packageFile.version)
    .option('--init', 'Creates a .pr-train.yml file with an example configuration')
    .option('-p, --push', 'Push changes')
    .option('-l, --list', 'List branches in current train')
    .option('-r, --rebase', 'Rebase branches rather than merging them')
    .option('-f, --force', 'Force push to remote')
    .option('--push-merged', 'Push all branches (inclusing those that have already been merged into master)')
    .option('--remote <remote>', 'Set remote to push to. Defaults to "origin"')
    .option('-c, --create-prs', 'Create GitHub PRs from your train branches');

  program.on('--help', () => {
    console.log('');
    console.log('  Switching branches:');
    console.log('');
    console.log(
      '    $ `git pr-train <index>` will switch to branch with index <index> (e.g. 0 or 5). ' +
        'If <index> is "combined", it will switch to the combined branch.'
    );
    console.log('');
    console.log('  Creating GitHub PRs:');
    console.log('');
    console.log(
      '    $ `git pr-train -p --create-prs` will create GH PRs for all branches in your train (with a "table of contents")'
    );
    console.log(
      colors.italic(
        `    Please note you'll need to create a \`\${HOME}/.pr-train\` file with your GitHub access token first.`
      )
    );
    console.log('');
  });

  program.parse(process.argv);

  program.createPrs && checkGHKeyExists();

  const sg = simpleGit();
  if (!(await sg.checkIsRepo())) {
    console.log('Not a git repo'.red);
    process.exit(1);
  }

  if (program.init) {
    return initializePrTrain(sg);
  }

  let ymlConfig;
  try {
    ymlConfig = await loadConfig(sg);
  } catch (e) {
    if (e instanceof yaml.YAMLException) {
      console.log('There seems to be an error in `.pr-train.yml`.');
      console.log(e.message);
      process.exit(1);
    }
    console.log('`.pr-train.yml` file not found. Please run `git pr-train --init` to create one.'.red);
    process.exit(1);
  }

  const { current: currentBranch, all: allBranches } = await sg.branchLocal();
  const trainCfg = await getBranchesConfigInCurrentTrain(sg, ymlConfig);
  if (!trainCfg) {
    console.log(`Current branch ${currentBranch} is not a train branch.`);
    process.exit(1);
  }
  const sortedTrainBranches = getBranchesInCurrentTrain(trainCfg);
  const combinedTrainBranch = getCombinedBranch(trainCfg);

  if (combinedTrainBranch && !allBranches.includes(combinedTrainBranch)) {
    const lastBranchBeforeCombined = sortedTrainBranches[sortedTrainBranches.length - 2];
    await sg.raw(['branch', combinedTrainBranch, lastBranchBeforeCombined]);
  }

  await handleSwitchToBranchCommand(
      sg, sortedTrainBranches, combinedTrainBranch, program.args[0]);

  await printBranchesInTrain(sg, sortedTrainBranches, currentBranch,
                             combinedTrainBranch, program.list);
  if (program.list) {
    return;
  }

  // If we're creating PRs, don't combine branches (that might change branch HEADs and consequently
  // the PR titles and descriptions). Just push and create the PRs.
  if (program.createPrs) {
    await findAndPushBranches(sg, sortedTrainBranches, program.pushMerged,
                              program.force, program.remote);
    await ensurePrsExist(sg, sortedTrainBranches, combinedTrainBranch, program.remote);
    return;
  }

  for (let i = 0; i < sortedTrainBranches.length - 1; ++i) {
    const b1 = sortedTrainBranches[i];
    const b2 = sortedTrainBranches[i + 1];
    if (isBranchAncestor(b1, b2)) {
      console.log(`Branch ${b1} is an ancestor of ${b2} => nothing to do`);
      continue;
    }
    await combineBranches(sg, program.rebase, b1, b2);
    await sleep(MERGE_STEP_DELAY_MS);
  }

  if (program.push || program.pushMerged) {
    await findAndPushBranches(sg, sortedTrainBranches, program.pushMerged,
                              program.force, program.remote);
  }

  await sg.checkout(currentBranch);
}

main().catch(e => {
  console.log(`${emoji.get('x')}  An error occured. Was there a conflict perhaps?`.red);
  console.error('error', e);
});
