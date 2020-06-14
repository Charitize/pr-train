
// @ts-check
import simpleGit = require('simple-git/promise');
import difference = require('lodash.difference');
import { createCommand } from 'commander';
import emoji = require('node-emoji');
import fs = require('fs');
import yaml = require('js-yaml');
import { GitHubClient, checkGHKeyExists } from './github';
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
  return yaml.safeLoad(fs.readFileSync(path, 'utf8')) as Promise<PRTrainConfig>;
}

async function loadConfigOrExit(sg): Promise<PRTrainConfig> {
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
  return ymlConfig;
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

async function initGit(): Promise<[SimpleGit, GitClient]> {
  const sg = simpleGit();
  if (!(await sg.checkIsRepo())) {
    console.log('Not a git repo'.red);
    process.exit(1);
  }
  return [sg, new GitClient(sg, shellJsExec)];
}


/**
 * Creates a PR train yml file if it does not exist already.
 */
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
 * Parses a range string in the form <start>..<end> into integer indices ready
 * for a slice operation.
 *
 * Thus, the return for example "11..15" will be [11, 16].
 */
function rangeStringToRange(rangeString: string): [number, number] {
  const matches = rangeString.match(/(?<start>\d+)\.\.(?<end>\d+)/);
  if (matches === null || matches === undefined) {
    throw new Error("Range string must be in form <start>..<end>");
  }
  const { start, end } = matches.groups as { start: string, end: string};
  return [parseInt(start), parseInt(end) + 1];
}

function commaSeparatedList(value, _) {
  return value.split(',');
}

/**
 * A client for performing train operations on a sequence of PRs.
 */
class PRTrainClient {
  constructor(private sg: SimpleGit, private git: GitClient,
              private sortedTrainBranches: string[], private currentBranch: string,
              private combinedTrainBranch: string | undefined) {
  }

  /**
   * Loads the PR train config and creates the client.
   *
   * This asynchronously creates the required dependencies for PRTrainClient.
   */
  public static async create(sg: SimpleGit, git: GitClient) {
    const ymlConfig = await loadConfigOrExit(sg);

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

    return new PRTrainClient(sg, git, sortedTrainBranches, currentBranch, combinedTrainBranch);
  }

  /**
   * Prints a list of the branches found in the PR train.
   */
  public async printBranchesInTrain() {
    console.log(`I've found these partial branches:`);
    const branchesToPrint = this.sortedTrainBranches.map((b, idx) => {
      const branch = b === this.currentBranch ? `${b.green.bold}` : b;
      const suffix = b === this.combinedTrainBranch ? ' (combined)' : '';
      return `[${idx}] ${branch}${suffix}`;
    });

    console.log(branchesToPrint.map(b => ` -> ${b}`).join('\n'), '\n');
  }

  public currentIndex(): number {
    return this.sortedTrainBranches.indexOf(this.currentBranch);
  }

  public branchNameAtIndex(i: number | 'combined'): string {
    let branch;
    if (i === 'combined') {
      branch = this.combinedTrainBranch;
    } else {
      branch = this.sortedTrainBranches[i];
    }
    if (!branch) {
      console.log(`Could not find branch with index ${i}`.red);
      process.exit(3);
    }
    return branch;
  }

  /**
   * Switches the branch to the branch named as the first program argument.
   *
   * "combined" is handled specially to switch to the tip branch.
   */
  public async switchToBranch(switchToBranchIndex: number | 'combined') {
    const targetBranch = this.branchNameAtIndex(switchToBranchIndex);
    await this.sg.checkout(targetBranch);
    console.log(`Switched to branch ${targetBranch}`);
    process.exit(0);
  }

  /**
   * Prompts the user with a list of branches they can checkout and checks out
   * the branch out.
   */
  public async selectBranchInTrain() {
    console.log(`I've found these partial branches:`);
    const branchesToPrint = this.sortedTrainBranches.map((b, idx) => {
      const branch = b === this.currentBranch ? `${b.green.bold}` : b;
      const suffix = b === this.combinedTrainBranch ? ' (combined)' : '';
      return `[${idx}] ${branch}${suffix}`;
    });

    const answer = await inquirer.prompt([
      {
        type: 'list',
        name: 'branch',
        message: 'Select a branch to checkout',
        choices: branchesToPrint.map((b, i) => ({ name: b, value: this.sortedTrainBranches[i] })),
        pageSize: 20,
      },
    ]);
    console.log(`checking out branch ${answer.branch}`);
    await this.sg.checkout(answer.branch);
  }

  /**
   * Looks for the branches in the current train not yet merged into
   * `stableBranch` and pushes them.
   *
   * @param pushMerged If true, pushes branches even if merged into
   *                   `stableBranch`.
   * @param force If the branch history differs from origin, force pushes.
   * @param remote The git remote to push to.
   * @param stableBranch The stable branch to merge into. Often master, but in
   *                     many cases is develop or other branches to base off of.
   * @param rangeString Range of branches to push in the notation <start>..<end>
   *                    (inclusive.)
   */
  public async findAndPushBranches(
      pushMerged: boolean, force: boolean, remote: string, stableBranch: string,
      rangeString?: string) {
    const range = rangeString
        ? rangeStringToRange(rangeString)
        : [0, this.sortedTrainBranches.length];
    const requestedBranches = this.sortedTrainBranches.slice(...range);
    let branchesToPush = requestedBranches;
    if (!pushMerged) {
      branchesToPush = await this.git.getUnmergedBranches(branchesToPush, stableBranch);
      const branchDiff = difference(requestedBranches, branchesToPush);
      if (branchDiff.length > 0) {
        console.log(`Not pushing already merged branches: ${branchDiff.join(', ')}`);
      }
    }
    await this.git.pushBranches(branchesToPush, force, remote);
  }

  /**
   * Reflows branches in PR train so that upstream changes are populated to
   * downstream ones.
   *
   * @param rebase If the strategy should be via rebasing, else merging.
   */
  public async reflowTrain(rebase: boolean) {
    for (let i = 0; i < this.sortedTrainBranches.length - 1; ++i) {
      const b1 = this.sortedTrainBranches[i];
      const b2 = this.sortedTrainBranches[i + 1];
      if (this.git.isBranchAncestor(b1, b2)) {
        console.log(`Branch ${b1} is an ancestor of ${b2} => nothing to do`);
        continue;
      }
      await this.git.combineBranches(rebase, b1, b2);
      await sleep(MERGE_STEP_DELAY_MS);
    }

    await this.sg.checkout(this.currentBranch);
  }

  /**
   * Creates and updates the PRs in the PR train.
   *
   * @param remote The name of the remote to update PRs on.
   * @param stableBranch The stable branch PRs will merge into.
   * @param rangeString Range of branches to create PRs for in the notation
   *                    <start>..<end> (inclusive.)
   */
  public async ensurePrsExist(remote: string, stableBranch: string,
                              rangeString?: string) {
    const range = rangeString
        ? rangeStringToRange(rangeString)
        : [0, this.sortedTrainBranches.length];
    const requestedBranches = this.sortedTrainBranches.slice(...range);

    const gitHubClient = new GitHubClient(this.sg);
    await gitHubClient.ensurePrsExist(
        requestedBranches, this.combinedTrainBranch, remote,
        stableBranch);
  }
}

async function main() {
  const [sg, git] = await initGit();

  const program = createCommand();
  program
      .version(packageFile.version);

  program
      .command('init')
      .description('Creates a .pr-train.yml file with an example configuration')
      .action(async () => {
        initializePrTrain(sg)
      });

  program
      .command('list')
      .description('List branches in current train')
      .action(async () => {
        const prTrainClient: PRTrainClient = await PRTrainClient.create(sg, git);
        await prTrainClient.printBranchesInTrain();
      });

  program
      .command('checkout [index]')
      .description('Switches to the branch indexed. Prompts user to select branch if no index is provided.')
      .action(async (index?: number) => {
        const prTrainClient: PRTrainClient = await PRTrainClient.create(sg, git);
        if (index === undefined) {
          await prTrainClient.selectBranchInTrain();
        } else {
          await prTrainClient.switchToBranch(index);
        }
      });

  program
      .command('previous')
      .description('Switches to the previous branch in the train.')
      .action(async () => {
        const prTrainClient: PRTrainClient = await PRTrainClient.create(sg, git);
        const index = prTrainClient.currentIndex();
        await prTrainClient.switchToBranch(index - 1);
      });

  program
      .command('next')
      .description('Switches to the next branch in the train.')
      .action(async () => {
        const prTrainClient: PRTrainClient = await PRTrainClient.create(sg, git);
        const index = prTrainClient.currentIndex();
        await prTrainClient.switchToBranch(index + 1);
      });

  program
      .command('merge')
      .description('Reflow PR train merging upstream changes into the downstream branches.')
      .action(async () => {
        const prTrainClient: PRTrainClient = await PRTrainClient.create(sg, git);
        await prTrainClient.printBranchesInTrain();
        await prTrainClient.reflowTrain(/*rebase=*/false);
      });

  program
      .command('rebase')
      .description('Reflow PR train rebasing downstream branches onto upstream changes.')
      .action(async () => {
        const prTrainClient: PRTrainClient = await PRTrainClient.create(sg, git);
        await prTrainClient.printBranchesInTrain();
        await prTrainClient.reflowTrain(/*rebase=*/true);
      });

  const infoCommand = program
      .command('info')
      .description('Gets information about the pr-train.');

  infoCommand
      .command('next')
      .description('Gets the next branch name')
      .action(async() => {
        const prTrainClient: PRTrainClient = await PRTrainClient.create(sg, git);
        const index = prTrainClient.currentIndex();
        await console.log(prTrainClient.branchNameAtIndex(index + 1));
      });

  infoCommand
      .command('previous')
      .description('Gets the previous branch name')
      .action(async() => {
        const prTrainClient: PRTrainClient = await PRTrainClient.create(sg, git);
        const index = prTrainClient.currentIndex();
        await console.log(prTrainClient.branchNameAtIndex(index - 1));
      });

  interface PushCommandOptions {
    force: boolean;
    pushMerged: boolean;
    range: string;
    stableBranch: string;
    remote: string;
  }
  program
      .command('push')
      .description('Push changes.')
      .option('-f, --force', 'Force push to remote')
      .option('--push-merged', 'Push all branches (inclusing those that have already been merged into stable-branch)')
      .option('--range <range>', 'Pushes only those branches in a range. Uses index..index notation. (e.g. 0..17)')
      .option('--stable-branch <branch>', 'The branch used for the PR train to merge into. Defaults to master.', 'master')
      .option('--remote <remote>', 'Set remote to push to. Defaults to "origin"', DEFAULT_REMOTE)
      .action(async (options: PushCommandOptions) => {
        const prTrainClient: PRTrainClient = await PRTrainClient.create(sg, git);
        await prTrainClient.printBranchesInTrain();
        const { force, pushMerged, range, remote, stableBranch } = options;
        await prTrainClient.findAndPushBranches(
            pushMerged, force, remote, stableBranch, range);
      });

  interface CreatePrsCommandOptions {
    stableBranch: string;
    range: string;
    remote: string;
  }
  program
      .command('create-prs')
      .description('Create GitHub PRs from your train branches')
      .option('--range <range>', 'Pushes only those branches in a range. Uses index..index notation. (e.g. 0..17)')
      .option('--stable-branch <branch>', 'The branch used for the PR train to merge into. Defaults to master.', 'master')
      .option('--remote <remote>', 'Set remote to push to. Defaults to "origin"', DEFAULT_REMOTE)
      .action(async (options: CreatePrsCommandOptions) => {
        const prTrainClient: PRTrainClient = await PRTrainClient.create(sg, git);
        checkGHKeyExists();
        await prTrainClient.printBranchesInTrain();
        await prTrainClient.ensurePrsExist(options.remote, options.stableBranch, options.range);
      });


  await program.parseAsync(process.argv);
  if (!program.args.length) program.help();
}

main().catch(e => {
  console.log(`${emoji.get('x')}  An error occured. Was there a conflict perhaps?`.red);
  console.error('error', e);
});
