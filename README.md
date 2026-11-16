Developer website served by GitHub Pages at https://lukemorse.dev
(also https://lukemorse.github.io).

Pages builds from the root of `main`. Pushing to `main` deploys, and the change
is usually live within a minute or two.

## What's here

- `app-ads.txt` must stay at the root. AdMob crawls it from the developer
  website listed in each store.
- One folder per app, each with a `privacy.md` (rendered by Jekyll, so
  `cloudfish/privacy.md` is served at `/cloudfish/privacy`).
- CloudFish sources live in the CloudFishMailMan repo under `Store/`; copy
  changes here.
- Everything listed in `.balloons-files` (`index.html`, `main.dart.js`,
  `flutter*.js`, `balloon_audio.js`, `assets/`, `dsp/`, `faustwasm/`, ...) is
  the home page: a Flutter web build of `~/development/luke_balloons`. Don't
  edit these files by hand; they are replaced on every balloons deploy.

## Deploying the home page

Make changes in `~/development/luke_balloons`, then:

```bash
cd ~/development/luke_balloons
tool/deploy.sh           # add --dsp after editing a .dsp voice
cd ~/development/lukemorse.github.io
git add -A && git status
git commit -m "Deploy balloons" && git push
```

`deploy.sh` builds the site, deletes the files it copied last time (from
`.balloons-files`), copies the new build here and rewrites `.balloons-files`.
It never touches `app-ads.txt`, `cloudfish/`, `_config.yml`, `README.md` or
`CNAME`, and it doesn't commit or push.

## Deploying anything else

Edit the files here, then commit and push to `main`.
