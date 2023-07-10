import { castArray, defaultTo, pick } from "lodash-es";
import AggregateError from "aggregate-error";
import { temporaryFile } from "tempy";
import getPkg from "./lib/get-pkg.js";
import verifyNpmConfig from "./lib/verify-config.js";
import verifyNpmAuth from "./lib/verify-auth.js";
import addChannelNpm from "./lib/add-channel.js";
import prepareNpm from "./lib/prepare.js";
import publishNpm from "./lib/publish.js";

import envCi from "env-ci";
import hideSensitive from "./lib/hide-sensitive.js";
import getConfig from "./lib/get-config.js";
import verify from "./lib/verify.js";
import getGitAuthUrl from "./lib/get-git-auth-url.js";
import getBranches from "./lib/branches/index.js";
import getLastRelease from "./lib/get-last-release.js";
import { addNote, getGitHead, getTagHead, isBranchUpToDate, push, pushNotes, tag, verifyAuth } from "./lib/git.js";
import { extractErrors, makeTag } from "./lib/utils.js";
import { hookStd } from "hook-std";
import debugFactory from "debug";
const debug = debugFactory("juice-js:semantic-release-npm");

let verified;
let prepared;
const npmrc = temporaryFile({ name: ".npmrc" });

export async function verifyConditions(pluginConfig, context) {
  // If the npm publish plugin is used and has `npmPublish`, `tarballDir` or `pkgRoot` configured, validate them now in order to prevent any release if the configuration is wrong
  if (context.options.publish) {
    const publishPlugin =
      castArray(context.options.publish).find((config) => config.path && config.path === "@juice-js/semantic-release-npm") || {};

    pluginConfig.npmPublish = defaultTo(pluginConfig.npmPublish, publishPlugin.npmPublish);
    pluginConfig.tarballDir = defaultTo(pluginConfig.tarballDir, publishPlugin.tarballDir);
    pluginConfig.pkgRoot = defaultTo(pluginConfig.pkgRoot, publishPlugin.pkgRoot);
  }

  const errors = verifyNpmConfig(pluginConfig);

  try {
    const pkg = await getPkg(pluginConfig, context);

    // Verify the npm authentication only if `npmPublish` is not false and `pkg.private` is not `true`
    if (pluginConfig.npmPublish !== false && pkg.private !== true) {
      await verifyNpmAuth(npmrc, pkg, context);
    }
  } catch (error) {
    errors.push(...error.errors);
  }

  if (errors.length > 0) {
    throw new AggregateError(errors);
  }

  verified = true;
}

export async function prepare(pluginConfig, context) {
  const errors = verified ? [] : verifyNpmConfig(pluginConfig);

  try {
    // Reload package.json in case a previous external step updated it
    const pkg = await getPkg(pluginConfig, context);
    if (!verified && pluginConfig.npmPublish !== false && pkg.private !== true) {
      await verifyNpmAuth(npmrc, pkg, context);
    }
  } catch (error) {
    errors.push(...error.errors);
  }

  if (errors.length > 0) {
    throw new AggregateError(errors);
  }

  await prepareNpm(npmrc, pluginConfig, context);
  
  prepared = true;
}

export async function publish(pluginConfig, context) {
  let pkg;
  const errors = verified ? [] : verifyNpmConfig(pluginConfig);

  try {
    // Reload package.json in case a previous external step updated it
    pkg = await getPkg(pluginConfig, context);
    if (!verified && pluginConfig.npmPublish !== false && pkg.private !== true) {
      await verifyNpmAuth(npmrc, pkg, context);
    }
  } catch (error) {
    errors.push(...error.errors);
  }

  if (errors.length > 0) {
    throw new AggregateError(errors);
  }

  if (!prepared) {
    await prepareNpm(npmrc, pluginConfig, context);
  }

  return publishNpm(npmrc, pluginConfig, pkg, context);
}

export async function addChannel(pluginConfig, context) {
  let pkg;
  const errors = verified ? [] : verifyNpmConfig(pluginConfig);

  try {
    // Reload package.json in case a previous external step updated it
    pkg = await getPkg(pluginConfig, context);
    if (!verified && pluginConfig.npmPublish !== false && pkg.private !== true) {
      await verifyNpmAuth(npmrc, pkg, context);
    }
  } catch (error) {
    errors.push(...error.errors);
  }

  if (errors.length > 0) {
    throw new AggregateError(errors);
  }

  return addChannelNpm(npmrc, pluginConfig, pkg, context);
}



/**
 * Determine the type of release to create based on a list of commits.
 *
 * @param {Object} pluginConfig The plugin configuration.
 * @param {String} pluginConfig.preset conventional-changelog preset ('angular', 'atom', 'codemirror', 'ember', 'eslint', 'express', 'jquery', 'jscs', 'jshint')
 * @param {String} pluginConfig.config Requireable npm package with a custom conventional-changelog preset
 * @param {String|Array} pluginConfig.releaseRules A `String` to load an external module or an `Array` of rules.
 * @param {Object} pluginConfig.parserOpts Additional `conventional-changelog-parser` options that will overwrite ones loaded by `preset` or `config`.
 * @param {Object} context The semantic-release context.
 * @param {Array<Object>} context.commits The commits to analyze.
 * @param {String} context.cwd The current working directory.
 *
 * @returns {String|null} the type of release to create based on the list of commits or `null` if no release has to be done.
 */
export async function analyzeCommits(pluginConfig, context) {
  const { logger, lastRelease } = context;
  let releaseType = null;
  if(lastRelease && lastRelease.version) {
    logger.log("Found last release version %s. The release type return in this step is only placeholder for other steps after.", lastRelease.version);
    releaseType = "patch";
  }
  return releaseType;
}


/* eslint complexity: off */
async function run(context, plugins) {
  const { cwd, env, options, logger, envCi } = context;
  const { isCi, branch, prBranch, isPr } = envCi;
  const ciBranch = isPr ? prBranch : branch;

  if (!isCi && !options.dryRun && !options.noCi) {
    logger.warn("This run was not triggered in a known CI environment, running in dry-run mode.");
    options.dryRun = true;
  } else {
    // When running on CI, set the commits author and committer info and prevent the `git` CLI to prompt for username/password. See #703.
    Object.assign(env, {
      GIT_AUTHOR_NAME: COMMIT_NAME,
      GIT_AUTHOR_EMAIL: COMMIT_EMAIL,
      GIT_COMMITTER_NAME: COMMIT_NAME,
      GIT_COMMITTER_EMAIL: COMMIT_EMAIL,
      ...env,
      GIT_ASKPASS: "echo",
      GIT_TERMINAL_PROMPT: 0,
    });
  }

  if (isCi && isPr && !options.noCi) {
    logger.log("This run was triggered by a pull request and therefore a new version won't be published.");
    return false;
  }

  // Verify config
  await verify(context);

  options.repositoryUrl = await getGitAuthUrl({ ...context, branch: { name: ciBranch } });
  context.branches = await getBranches(options.repositoryUrl, ciBranch, context);
  context.branch = context.branches.find(({ name }) => name === ciBranch);

  if (!context.branch) {
    logger.log(
      `This test run was triggered on the branch ${ciBranch}, while semantic-release is configured to only publish from ${context.branches
        .map(({ name }) => name)
        .join(", ")}, therefore a new version won’t be published.`
    );
    return false;
  }

  logger[options.dryRun ? "warn" : "success"](
    `Run automated release from branch ${ciBranch} on repository ${options.originalRepositoryURL}${
      options.dryRun ? " in dry-run mode" : ""
    }`
  );

  try {
    try {
      await verifyAuth(options.repositoryUrl, context.branch.name, { cwd, env });
    } catch (error) {
      if (!(await isBranchUpToDate(options.repositoryUrl, context.branch.name, { cwd, env }))) {
        logger.log(
          `The local branch ${context.branch.name} is behind the remote one, therefore a new version won't be published.`
        );
        return false;
      }

      throw error;
    }
  } catch (error) {
    logger.error(`The command "${error.command}" failed with the error message ${error.stderr}.`);
    throw getError("EGITNOPERMISSION", context);
  }

  logger.success(`Allowed to push to the Git repository`);

  await verifyConditions(context);

  const errors = [];
  context.releases = [];
  
  context.lastRelease = getLastRelease(context);
  if (context.lastRelease.gitHead) {
    context.lastRelease.gitHead = await getTagHead(context.lastRelease.gitHead, { cwd, env });
  }

  if (context.lastRelease.gitTag) {
    logger.log(
      `Found git tag ${context.lastRelease.gitTag} associated with version ${context.lastRelease.version} on branch ${context.branch.name}`
    );
  } else {
    logger.log(`No git tag version found on branch ${context.branch.name}`);
  }

  await prepare(context);

  const releases = await publish(context);
  context.releases.push(...releases);

  // await success({ ...context, releases });

  logger.success(
    `Published release ${nextRelease.version} on ${nextRelease.channel ? nextRelease.channel : "default"} channel`
  );

  return pick(context, ["lastRelease", "commits", "nextRelease", "releases"]);
}

export default async (cliOptions = {}, { cwd = process.cwd(), env = process.env, stdout, stderr } = {}) => {
  const { unhook } = hookStd(
    { silent: false, streams: [process.stdout, process.stderr, stdout, stderr].filter(Boolean) },
    hideSensitive(env)
  );
  const context = {
    cwd,
    env,
    stdout: stdout || process.stdout,
    stderr: stderr || process.stderr,
    envCi: envCi({ env, cwd }),
  };
  context.logger = getLogger(context);
  context.logger.log(`Running ${pkg.name} version ${pkg.version}`);
  try {
    const { plugins, options } = await getConfig(context, cliOptions);
    options.originalRepositoryURL = options.repositoryUrl;
    context.options = options;
    try {
      const result = await run(context, plugins);
      unhook();
      return result;
    } catch (error) {
      await callFail(context, plugins, error);
      throw error;
    }
  } catch (error) {
    await logErrors(context, error);
    unhook();
    throw error;
  }
};

async function logErrors({ logger, stderr }, err) {
  const errors = extractErrors(err).sort((error) => (error.semanticRelease ? -1 : 0));
  for (const error of errors) {
    if (error.semanticRelease) {
      logger.error(`${error.code} ${error.message}`);
      if (error.details) {
        stderr.write(await terminalOutput(error.details)); // eslint-disable-line no-await-in-loop
      }
    } else {
      logger.error("An error occurred while running semantic-release: %O", error);
    }
  }
}
async function callFail(context, plugins, err) {
  const errors = extractErrors(err).filter((err) => err.semanticRelease);
  if (errors.length > 0) {
    try {
      await plugins.fail({ ...context, errors });
    } catch (error) {
      await logErrors(context, error);
    }
  }
}