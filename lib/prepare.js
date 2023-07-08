import path from "path";
import { move } from "fs-extra";
import { execa } from "execa";

import debugFactory from "debug";
const debug = debugFactory("juice-js:semantic-release-npm");

export default async function (
  npmrc,
  { tarballDir, pkgRoot, localPackages },
  { cwd, env, stdout, stderr, lastRelease: { version }, logger }
) {
  const basePath = pkgRoot ? path.resolve(cwd, pkgRoot) : cwd;

  logger.log("Write last release version %s to package.json in %s", version, basePath);

  const versionResult = execa(
    "npm",
    ["version", version, "--userconfig", npmrc, "--no-git-tag-version", "--allow-same-version"],
    {
      cwd: basePath,
      env,
      preferLocal: true,
    }
  );
  versionResult.stdout.pipe(stdout, { end: false });
  versionResult.stderr.pipe(stderr, { end: false });

  await versionResult;

  
  // update peerDependencies of same scope package to last release version
  logger.log(`Update peerDependencies of configured localPackages to last release version`);

  localPackages = localPackages || [];
  debug("localPackages: %o", localPackages);

  const peerDependenciesList = localPackages
    .map((name) => {
      return `${name}@${version}`;
    });
  if(peerDependenciesList.length > 0) {
    logger.log(`Install peerDependencies ${peerDependenciesList.join(",")}`);
    const result = execa(
      "npm",
      ["install", ...peerDependenciesList, "--userconfig", npmrc, "--registry", registry],
      { cwd, env, preferLocal: true }
    );
    result.stdout.pipe(stdout, { end: false });
    result.stderr.pipe(stderr, { end: false });
    await result;
  }else{
    logger.log(`No peerDependencies need to install`);
  }

  if (tarballDir) {
    logger.log("Creating npm package version %s", version);
    const packResult = execa("npm", ["pack", basePath, "--userconfig", npmrc], { cwd, env, preferLocal: true });
    packResult.stdout.pipe(stdout, { end: false });
    packResult.stderr.pipe(stderr, { end: false });

    const tarball = (await packResult).stdout.split("\n").pop();
    const tarballSource = path.resolve(cwd, tarball);
    const tarballDestination = path.resolve(cwd, tarballDir.trim(), tarball);

    // Only move the tarball if we need to
    // Fixes: https://github.com/semantic-release/npm/issues/169
    if (tarballSource !== tarballDestination) {
      await move(tarballSource, tarballDestination);
    }
  }
}
