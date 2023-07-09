import path from "path";
import { move } from "fs-extra";
import { execa } from "execa";
import getRegistry from "./get-registry.js";
import getPkg from "./get-pkg.js";
import {writePackage} from 'write-pkg';

export default async function (
  npmrc,
  pluginConfig,
  context
) {
  const { cwd, env, stdout, stderr, lastRelease: { version }, logger } = context;
  const { tarballDir, pkgRoot } = pluginConfig;
  let localPackages = pluginConfig.localPackages || [];
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

  
  // update depencencies, devDependencies, peerDependencies of same scope package to last release version
  logger.log(`Update depencencies, devDependencies, peerDependencies of configured localPackages to last release version`);

  try {
    // Reload package.json in case a previous external step updated it

    const pkg = await getPkg(pluginConfig, context);
    const registry = getRegistry(pkg, context);

    // convert updatePackages to peerDependenciesList with version
    if(typeof(localPackages) === "string") {
      localPackages = [localPackages];
    }
    logger.debug("updatePackages: %o", localPackages);

    if(Array.isArray(localPackages)) {
      if(pkg.peerDependencies){
        Object.keys(pkg.peerDependencies).forEach((key) => {
          if(localPackages.includes(key)) {
            pkg.peerDependencies[key] = version;
            logger.debug("update peerDependencies %s to %s", key, version);
          }
        });
      }
      if(pkg.dependencies){
        Object.keys(pkg.dependencies).forEach((key) => {
          if(localPackages.includes(key)) {
            pkg.dependencies[key] = version;
            logger.debug("update dependencies %s to %s", key, version);
          }
        });
      }
      if(pkg.devDependencies){
        Object.keys(pkg.devDependencies).forEach((key) => {
          if(localPackages.includes(key)) {
            pkg.devDependencies[key] = version;
            logger.debug("update devDependencies %s to %s", key, version);
          }
        });
      }
      await writePackage(basePath, pkg);
      logger.log("Write package.json in %s", basePath);
    }else{
      logger.log(`No peerDependencies need to install`);
    }
  } catch (error) {
    logger.error(error);
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
