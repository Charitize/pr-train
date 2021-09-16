// @ts-check
import octo = require('octonode');
import promptly = require('promptly');
import fs = require('fs');
import colors = require('colors');
import emoji = require('node-emoji');
import {SimpleGit} from "simple-git/promise";

interface PullRequestMessage {
  title: string;
  body: string;
}

/**
 * Client for managing Pull Requests in GitHub.
 */
export class GitHubClient {
  /**
   * @param sg SimpleGit client to manage PR message.
   */
  constructor(private sg: SimpleGit) {}

  /**
   * Creates a PR message based on the head commit of a branch.
   *
   * The title is based on the first line of the top commit, and the body as the
   * remaining content of the commit message.
   *

   * @param branch Name of the branch to create a
   * @return The pull request message.
   */
  private async constructPrMsg(branch: string): Promise<PullRequestMessage> {
    const title = await this.sg.raw(['log', '--format=%s', '-n', '1', branch]);
    const body = await this.sg.raw(['log', '--format=%b', '-n', '1', branch]);
    return {
      title: title.trim(),
      body: body.trim(),
    };
  }

  /**
   * Creates and updates existing PRs for the PR train.
   *
   * If a PR does not exist, creates one based on the branch with the previous
   * branch as the branch base. If the PR exists, updates the PR description and
   * Table of Contents along with updating to the correct base.
   *
   * @param allBranches Ordered list of all of the branches in the PR train.
   * @param combinedBranch The final branch with the combined changes at the tip
   *                       of the PR train.
   * @param remote The name of the remote to use for checking PRs against.
   * @param stableBranch The base stable branch to base all PRs off of. Often
   *                     master, but might be develop.
   * @param reviewers List of reviewers, which should be requested to review the
   *                  PR.
   * @param draft If true, creates PRs as draft PRs.
   */
  public async ensurePrsExist(
      allBranches: string[], combinedBranch: string | undefined,
      remote: string, stableBranch: string, reviewers: string[],
      draft: boolean) {
    //const allBranches = combinedBranch ? sortedBranches.concat(combinedBranch) : sortedBranches;
    const octoClient = octo.client(readGHKey());
    // TODO: take remote name from `-r` value.
    const remoteUrl = await this.sg.raw(['config', '--get', `remote.${remote}.url`]);
    if (!remoteUrl) {
      console.log(`URL for remote ${remote} not found in your git config`.red);
      process.exit(4);
    }

    /** @type string */
    let combinedBranchTitle;
    if (combinedBranch) {
      console.log();
      console.log(`Now I will need to know what to call your "combined" branch PR in GitHub.`);
      combinedBranchTitle = await promptly.prompt(colors.bold(`Combined branch PR title:`));
      if (!combinedBranchTitle) {
        console.log(`Cannot continue.`.red, `(I need to know what the title of your combined branch PR should be.)`);
        process.exit(5);
      }
    }

    const getCombinedBranchPrMsg = () => ({
      title: combinedBranchTitle,
      body: '',
    });

    console.log();
    console.log('This will create (or update) PRs for the following branches:');
    await allBranches.reduce(async (memo, branch) => {
      await memo;
      const {
        title
      } = branch === combinedBranch ? getCombinedBranchPrMsg() : await this.constructPrMsg(branch);
      console.log(`  -> ${branch.green} (${title.italic})`);
    }, Promise.resolve());

    console.log();
    if (!(await promptly.confirm(colors.bold('Shall we do this? [y/n] ')))) {
      console.log('No worries. Bye now.', emoji.get('wave'));
      process.exit(0);
    }

    const nickAndRepoMatch = remoteUrl.match(/github\.com[/:](.*)\.git/);
    if (nickAndRepoMatch === null || !nickAndRepoMatch[1]) {
      console.log(`I could not parse your remote ${remote} repo URL`.red);
      process.exit(4);
    }

    const nickAndRepo = nickAndRepoMatch[1];
    const nick = nickAndRepo.split('/')[0];
    const ghRepo = octoClient.repo(nickAndRepo);

    console.log('');
    // Construct branch_name <-> PR_data mapping.
    // Note: We're running this serially to have nicer logs.
    /**
     * @type Object.<string, {title: string, pr: number, body: string, updating: boolean}>
     */
    const prDict = await allBranches.reduce(async (_memo, branch, index) => {
      const memo = await _memo;
      const {
        title,
        body
      } = branch === combinedBranch ? getCombinedBranchPrMsg() : await this.constructPrMsg(branch);
      const base = index === 0 || branch === combinedBranch ? stableBranch : allBranches[index - 1];
      process.stdout.write(`Checking if PR for branch ${branch} already exists... `);
      const prs = await ghRepo.prsAsync({
        head: `${nick}:${branch}`,
      });
      let prResponse = prs[0] && prs[0][0];
      let prExists = false;
      if (prResponse) {
        console.log('yep');
        prExists = true;
      } else {
        console.log('nope');
        const payload = {
          head: branch,
          base,
          title,
          body,
          draft,
        };
        process.stdout.write(`Creating PR for branch "${branch}"...`);
        try {
          prResponse = (await ghRepo.prAsync(payload))[0];
        } catch (e) {
          console.error(JSON.stringify(e, null, 2));
          throw e;
        }
        console.log(emoji.get('white_check_mark'));
      }
      memo[branch] = {
        body: prResponse.body,
        title: prResponse.title,
        pr: prResponse.number,
        updating: prExists,
      };
      return memo;
    }, Promise.resolve({}));

    // Now that we have all the PRs, let's update them with the "navigation"
    // section and any changes to their diffbase.
    // Note: We're running this serially to have nicer logs.
    await allBranches.reduce(async (memo, branch, index) => {
      await memo;
      const prInfo = prDict[branch];
      const ghPr = octoClient.pr(nickAndRepo, prInfo.pr);
      const {
        title,
        body
      } = prInfo.updating ?
          prInfo // Updating existing PR: keep current body and title.
          :
          branch === combinedBranch ?
              getCombinedBranchPrMsg() :
              await this.constructPrMsg(branch);
      const base = index === 0 || branch === combinedBranch ? stableBranch : allBranches[index - 1];
      const navigation = constructTrainNavigation(prDict, branch, combinedBranch);

      const newBody = upsertNavigationInBody(navigation, body);
      process.stdout.write(`Updating PR for branch ${branch}...`);
      await ghPr.updateAsync({
        title,
        base,
        body: `${newBody}`,
      });

      if (reviewers.length > 0) {
        process.stdout.write(`Requesting reviewers ${reviewers}...`);
        await ghPr.createReviewRequestsAsync(reviewers);
      }

      console.log(emoji.get('white_check_mark'));
    }, Promise.resolve());
  }

}


interface BranchDetails {
  [branch: string]: { title: string, pr: number }
}

/**
 * Creates a table of contents for PR train.
 *
 * TOC is formatted, wrapped in <pr-train-toc> with a newline separated list of
 * each branch in the train formatted as:
 *
 * If the branch is the current branch in the PR:
 *  #<prNumber>(<prTitle>) **YOU ARE HERE**
 *
 * If the branch is the cumulative combined branch:
 * #<prNumber> **[combined branch]** (<prTitle>)
 *
 * Otherwise:
 * #<prNumber> (<prTitle>)
 *
 * @param branchToPrDict Lookup for branch name to the PR title and number
 *                       associated with it.
 * @param currentBranch The name of the branch this PR represents.
 * @param combinedBranch The combined branch with all PRs in it.
 */
function constructTrainNavigation(
    branchToPrDict: BranchDetails, currentBranch: string,
    combinedBranch: string | undefined) {
  let contents = '<pr-train-toc>\n\n#### PR chain:\n';
  contents = Object.keys(branchToPrDict).reduce((output, branch) => {
    const maybeHandRight = branch === currentBranch ? '👉 ' : '';
    const maybeHandLeft = branch === currentBranch ? ' 👈 **YOU ARE HERE**' : '';
    const combinedInfo = branch === combinedBranch ? ' **[combined branch]** ' : ' ';
    output += `${maybeHandRight}#${branchToPrDict[branch].pr}${combinedInfo}(${branchToPrDict[
      branch
    ].title.trim()})${maybeHandLeft}`;
    return output + '\n';
  }, contents);
  contents += '\n</pr-train-toc>';
  return contents;
}

/**
 * Checks for a GitHub key to exists in $HOME/.pr-train.
 *
 * If the key does not exist, exits the process with code 4.
 */
export function checkGHKeyExists() {
  try {
    readGHKey()
  } catch (e) {
    console.log(`"$HOME/.pr-train" not found. Please make sure file exists and contains your GitHub API key.`.red);
    process.exit(4);
  }
}

/** Reads the GitHub key from $HOME/.pr-train. */
function readGHKey(): string {
  return fs
    .readFileSync(`${process.env.HOME}/.pr-train`, 'UTF-8')
    .toString()
    .trim();
}

/**
 * Replaces a PR train table of contents in an existing PR body with the new
 * table of contents, otherwise adds it at the end.
 *
 * @param newNavigation The new table of contents to replace or add to the PR.
 * @param body The current body of the PR to update.
 * @return The updated body for the PR to use.
 */
function upsertNavigationInBody(newNavigation: string, body: string): string {
  if (body) {
    if (body.match(/<pr-train-toc>/)) {
      return body.replace(/<pr-train-toc>[^]*<\/pr-train-toc>/, newNavigation);
    } else {
      return body + '\n' + newNavigation;
    }
  } else {
    return newNavigation;
  }
}

