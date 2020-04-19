
// @ts-check
import simpleGit = require('simple-git/promise');
import difference = require('lodash.difference');
import { createCommand } from 'commander';
import emoji = require('node-emoji');
import fs = require('fs');
import yaml = require('js-yaml');
import { ensurePrsExist, checkGHKeyExists } from './github';
import colors = require('colors');
import {DEFAULT_REMOTE, MERGE_STEP_DELAY_MS} from './consts';
import path = require('path');
// @ts-ignore
import packageFile = require('../package.json');
import inquirer = require('inquirer');
import { SimpleGit } from "simple-git/promise";
import { GitClient } from "./git";
import { sleep } from "./sleep";
import { exec as shellJsExec } from 'shelljs';

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
function getCombinedBranch(branchConfig: BranchConfig[]): string | undefined {
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
    sg: SimpleGit, sortedBranches: string[], combinedBranch: string | undefined,
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
  if (require.main === undefined) {
    throw new Error('require.main is undefined.')
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
 * @param git Git client to interact with local git repository.
 * @param sortedBranches The branches in the current PR train.
 * @param pushMerged If true, pushes branches even if merged into master.
 * @param force If the branch history differs from origin, force pushes.
 * @param remote The git remote to push to.
 */
async function findAndPushBranches(
    git: GitClient, sortedBranches: string[],
    pushMerged: boolean, force: boolean, remote: string) {
  let branchesToPush = sortedBranches;
  if (!pushMerged) {
    branchesToPush = await git.getUnmergedBranches(sortedBranches);
    const branchDiff = difference(sortedBranches, branchesToPush);
    if (branchDiff.length > 0) {
      console.log(`Not pushing already merged branches: ${branchDiff.join(', ')}`);
    }
  }
  git.pushBranches(branchesToPush, force, remote);
}

async function printBranchesInTrain(
    sg: SimpleGit, sortedBranches: string[], currentBranch: string,
    combinedBranch: string | undefined, listBranches: boolean) {
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

async function initGit(): Promise<[SimpleGit, GitClient]> {
  const sg = simpleGit();
  if (!(await sg.checkIsRepo())) {
    console.log('Not a git repo'.red);
    process.exit(1);
  }
  return [sg, new GitClient(sg, shellJsExec)];
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
    .option('--remote <remote>', 'Set remote to push to. Defaults to "origin"', DEFAULT_REMOTE)
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

  const [sg, git] = await initGit();

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
    await findAndPushBranches(git, sortedTrainBranches, program.pushMerged,
                              program.force, program.remote);
    await ensurePrsExist(sg, sortedTrainBranches, combinedTrainBranch, program.remote);
    return;
  }

  for (let i = 0; i < sortedTrainBranches.length - 1; ++i) {
    const b1 = sortedTrainBranches[i];
    const b2 = sortedTrainBranches[i + 1];
    if (git.isBranchAncestor(b1, b2)) {
      console.log(`Branch ${b1} is an ancestor of ${b2} => nothing to do`);
      continue;
    }
    await git.combineBranches(program.rebase, b1, b2);
    await sleep(MERGE_STEP_DELAY_MS);
  }

  if (program.push || program.pushMerged) {
    await findAndPushBranches(git, sortedTrainBranches, program.pushMerged,
                              program.force, program.remote);
  }

  await sg.checkout(currentBranch);
}

main().catch(e => {
  console.log(`${emoji.get('x')}  An error occured. Was there a conflict perhaps?`.red);
  console.error('error', e);
});
