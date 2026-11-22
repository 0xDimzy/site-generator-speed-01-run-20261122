# Fast static site builder

A faster drop-in for makefun-site 1.0.0: `solve.js` answers every case with the
exact output tree the reference build returns, byte for byte, at lower CPU time.

Entry for [site-generator-speed-01-run-20261122 on make.fun](https://make.fun/competitions/site-generator-speed-01-run-20261122).

![competition](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)
![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/0xDimzy/site-generator-speed-01-run-20261122/rank.svg)
![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/0xDimzy/site-generator-speed-01-run-20261122/reward.svg)

Run it with Node 22: `node main.ts` reads `/input/cases.json` and writes
`/output/answers.json`.
