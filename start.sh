#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -f "${SCRIPT_DIR}/../common/dev-runner.mjs" ]; then
  exec node "${SCRIPT_DIR}/../common/dev-runner.mjs" "${SCRIPT_DIR}"
fi

exec node "${SCRIPT_DIR}/scripts/dev-runner.mjs" "${SCRIPT_DIR}"
