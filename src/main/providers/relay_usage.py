"""Return only quota fields from the installed relay's read-only provider."""
import json
import os
import sys
from pathlib import Path


def read_usage(root):
    os.environ["DOGE_PORTABLE_ROOT"] = str(root)
    sys.path.insert(0, str(root / "app"))
    from relay_claude_usage import ClaudeUsageUnavailable, fetch_raw

    try:
        raw = fetch_raw()
    except ClaudeUsageUnavailable as exc:
        reason = exc.args[0]
        allowed = ("auth", "expired", "network", "http", "rate_limited")
        return {"reason": reason if reason in allowed else "unavailable"}

    usage = {}
    for key in ("five_hour", "seven_day", "seven_day_sonnet", "seven_day_opus"):
        window = raw.get(key)
        if isinstance(window, dict):
            value = window.get("utilization")
            if type(value) in (int, float) and 0 <= value <= 100:
                reset = window.get("resets_at")
                usage[key] = {"utilization": value, "resets_at": reset if isinstance(reset, str) else None}
    extra = raw.get("extra_usage")
    if isinstance(extra, dict) and extra.get("is_enabled") is True:
        usage["extra_usage"] = {"is_enabled": True, **{
            key: extra[key] for key in ("used_credits", "monthly_limit")
            if type(extra.get(key)) in (int, float)
        }}
    return {"usage": usage}


if __name__ == "__main__":
    print(json.dumps(read_usage(Path(sys.argv[1]).resolve()), allow_nan=False))
