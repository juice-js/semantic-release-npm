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
import getCommits from "./lib/get-commits.js";
import getLogger from "./lib/get-logger.js";
import { getTagHead, isBranchUpToDate, verifyAuth } from "./lib/git.js";
import { extractErrors } from "./lib/utils.js";
import path from "path";
import { hookStd } from "hook-std";
import { createRequire } from "node:module";
import debugFactory from "debug";
import { COMMIT_EMAIL, COMMIT_NAME } from "./lib/definitions/constants.js";
const debug = debugFactory("juice-js:semantic-release-npm");
const require = createRequire(import.meta.url);

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

  await verifyConditions(context.options, context);

  const errors = [];
  context.releases = [];
  
  context.lastRelease = getLastRelease(context);

  if (context.lastRelease.gitHead) {
    context.commits = await getCommits(context);

    const type = await plugins.analyzeCommits(context);
  
    if(!type){
      logger.log("There are no relevant changes, so no new version is released.");
      return false;
    }
    context.lastRelease.gitHead = await getTagHead(context.lastRelease.gitHead, { cwd, env });
  }

  if (context.lastRelease.gitTag) {
    var channel = context.branch.channel || "null";
    var lastReleaseChannel = context.lastRelease.channel || "null";
    
    logger.log(
      `Found git tag ${context.lastRelease.gitTag} @${lastReleaseChannel} associated with version ${context.lastRelease.version} on branch ${context.branch.name}, channel ${channel}`
    );
    // If last release channel is null and branch channel is not null, we need to publish to the branch channel
    if(!context.lastRelease.channel && context.branch.channel){
      logger.log(`Use branch channel ${context.branch.channel} instead of last release channel`);
      context.lastRelease.channel = context.branch.channel;
    }
  } else {
    logger.log(`No git tag version found on branch ${context.branch.name}`);
  }

  await prepare(context.options, context);

  const release = await publish(context.options, context);
  if(release){
    context.releases.push(release);
    
    logger.success(
      `Published release ${context.lastRelease.version} on ${context.lastRelease.channel ? context.lastRelease.channel : "default"} channel`
    );
  }else{
    logger.log(`No release published`);
  }

  // await success({ ...context, releases });

  return pick(context, ["lastRelease", "commits", "releases"]);
}

export default async (cliOptions = {}, { cwd = process.cwd(), env = process.env, stdout, stderr } = {}) => {
  const { unhook } = hookStd(
    { silent: false, streams: [process.stdout, process.stderr, stdout, stderr].filter(Boolean) },
    hideSensitive(env)
  );
  const { pkgRoot } = cliOptions;
  let basePath = pkgRoot ? path.resolve(cwd, String(pkgRoot)) : cwd;
  const pkg = require(`${basePath}/package.json`);
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