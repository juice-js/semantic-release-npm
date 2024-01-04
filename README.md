# @juice-js/semantic-release-npm

Use this step with [**semantic-release**](https://github.com/semantic-release/semantic-release) together to publish multiple [npm](https://www.npmjs.com) packages in the same repo (mono-repo).

[![Release](https://github.com/juice-js/semantic-release-npm/actions/workflows/release.yml/badge.svg?branch=master)](https://github.com/juice-js/semantic-release-npm/actions/workflows/release.yml) [![npm latest version](https://img.shields.io/npm/v/@juice-js/semantic-release-npm/latest.svg)](https://www.npmjs.com/package/@juice-js/semantic-release-npm)
[![npm next version](https://img.shields.io/npm/v/@juice-js/semantic-release-npm/next.svg)](https://www.npmjs.com/package/@juice-js/semantic-release-npm)
[![npm beta version](https://img.shields.io/npm/v/@juice-js/semantic-release-npm/beta.svg)](https://www.npmjs.com/package/@juice-js/semantic-release-npm)

| Step               | Description                                                                                                                      |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `verifyConditions` | Verify the presence of the `NPM_TOKEN` environment variable, or an `.npmrc` file, and verify the authentication method is valid. |
| `getLastRelease` | Read last tagged release to use the same version |
| `prepare`          | Update the `package.json` version and [create](https://docs.npmjs.com/cli/pack) the npm package tarball.                         |
| `addChannel`       | [Add a release to a dist-tag](https://docs.npmjs.com/cli/dist-tag).                                                              |
| `publish`          | [Publish the npm package](https://docs.npmjs.com/cli/publish) to the registry.                                                   |

## Install

```bash
$ npm install @juice-js/semantic-release-npm -D
```

## Usage

Add more steps to publish your next packages after run [**semantic-release**](https://github.com/semantic-release/semantic-release) for your first package in the same repo.

```yml
    steps:
      - uses: actions/checkout@v3
      # Setup .npmrc file to publish to GitHub Packages
      - uses: actions/setup-node@v3
        with:
          node-version: '18.x'
      - run: npm ci
      - run: npm run build @juice-js/dict-builder --if-present
      - run: npm run build @juice-js/tenants --if-present
      - run: npm test -- --watch=false --browsers=ChromeHeadless
      # Use semantic-release to publish dist package to npmjs
      # After this step, new tag will be created on github repo.
      - run: npx semantic-release --plugins=@semantic-release/commit-analyzer,@semantic-release/release-notes-generator,@semantic-release/npm --pkgRoot=./dist/juice-js/dict-builder
      # Use github tag on the last step to change dependencies version
      # and publish package with the same version to npmjs
      - run: npx @juice-js/semantic-release-npm --pkgRoot=./dist/juice-js/tenants --localPackages=@juice-js/dict-builder --debug
```

## Configuration

### npm registry authentication

The npm [token](https://docs.npmjs.com/about-access-tokens) authentication configuration is **required** and can be set via [environment variables](#environment-variables).

Automation tokens are recommended since they can be used for an automated workflow, even when your account is configured to use the [`auth-and-writes` level of 2FA](https://docs.npmjs.com/about-two-factor-authentication#authorization-and-writes).

### npm provenance

If you are publishing to the official registry and your pipeline is on a [provider that is supported by npm for provenance](https://docs.npmjs.com/generating-provenance-statements#provenance-limitations), npm can be configured to [publish with provenance](https://docs.npmjs.com/generating-provenance-statements).

Since semantic-release wraps the npm publish command, configuring provenance is not exposed directly.
Instead, provenance can be configured through the [other configuration options exposed by npm](https://docs.npmjs.com/generating-provenance-statements#using-third-party-package-publishing-tools).
Provenance applies specifically to publishing, so our recommendation is to configure under `publishConfig` within the `package.json`.

#### npm provenance on GitHub Actions

For package provenance to be signed on the GitHub Actions CI the following permission is required
to be enabled on the job:

```yaml
permissions:
  id-token: write # to enable use of OIDC for npm provenance
```

It's worth noting that if you are using semantic-release to its fullest with a GitHub release, GitHub comments,
and other features, then [more permissions are required](https://github.com/semantic-release/github#github-authentication) to be enabled on this job:

```yaml
permissions:
  contents: write # to be able to publish a GitHub release
  issues: write # to be able to comment on released issues
  pull-requests: write # to be able to comment on released pull requests
  id-token: write # to enable use of OIDC for npm provenance
```

Refer to the [GitHub Actions recipe for npm package provenance](https://semantic-release.gitbook.io/semantic-release/recipes/ci-configurations/github-actions#.github-workflows-release.yml-configuration-for-node-projects) for the full CI job's YAML code example.

### Environment variables

| Variable    | Description                                                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `NPM_TOKEN` | Npm token created via [npm token create](https://docs.npmjs.com/getting-started/working_with_tokens#how-to-create-new-tokens) |

### Options

| Options      | Description                                                                                                        | Default                                                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `npmPublish` | Whether to publish the `npm` package to the registry. If `false` the `package.json` version will still be updated. | `false` if the `package.json` [private](https://docs.npmjs.com/files/package.json#private) property is `true`, `true` otherwise. |
| `pkgRoot`    | Directory path to publish.                                                                                         | `.`                                                                                                                              |
| `localPackages` | Specify your referenced packages in the same repo to replace its version in package.json    | `[]`                                                                                                                          |

**Note**: The `pkgRoot` directory must contain a `package.json`. The version will be updated only in the `package.json` and `npm-shrinkwrap.json` within the `pkgRoot` directory.

**Note**: If you use a [shareable configuration](https://github.com/semantic-release/semantic-release/blob/master/docs/usage/shareable-configurations.md#shareable-configurations) that defines one of these options you can set it to `false` in your [**semantic-release** configuration](https://github.com/semantic-release/semantic-release/blob/master/docs/usage/configuration.md#configuration) in order to use the default value.

### npm configuration

The plugin uses the [`npm` CLI](https://github.com/npm/cli) which will read the configuration from [`.npmrc`](https://docs.npmjs.com/files/npmrc). See [`npm config`](https://docs.npmjs.com/misc/config) for the option list.

The [`registry`](https://docs.npmjs.com/misc/registry) can be configured via the npm environment variable `NPM_CONFIG_REGISTRY` and will take precedence over the configuration in `.npmrc`.

**Notes**:

- The presence of an `.npmrc` file will override any specified environment variables.
- The presence of `registry` or `dist-tag` under `publishConfig` in the `package.json` will take precedence over the configuration in `.npmrc` and `NPM_CONFIG_REGISTRY`