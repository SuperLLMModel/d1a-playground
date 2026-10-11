"""python3 -m unittest scripts/test_check_hygiene.py: the pull-request checks refuse AI attribution, our local paths on
added lines and a launcher pinning another D1A; ordinary lines, other people's paths and agreeing pins pass."""
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import check_hygiene as H  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent


class Checks(unittest.TestCase):
    def test_attribution(self):
        self.assertTrue(H.attribution("x\n\nCo-Authored-By: Claude <noreply@anthropic.com>"))
        self.assertFalse(H.attribution("Co-Authored-By: Jane <jane@example.com>"))

    def test_paths_only_added_and_ours(self):
        diff = "\n".join(["+++ b/a.md", "+in /Users/" + "john/x", "-in /private/tmp/" + "claude-1/y", "+/Users/" + "Shared/d1a/z"])
        self.assertEqual([f for f, _ in H.local_paths_in_diff(diff)], ["a.md"])

    def test_this_file_and_the_checker_hold_no_path(self):
        for f in ("scripts/check_hygiene.py", "scripts/test_check_hygiene.py"):
            src = (ROOT / f).read_text(encoding="utf-8")
            self.assertFalse(H.local_paths_in_diff(f"+++ b/{f}\n" + "\n".join("+" + l for l in src.splitlines())), f)

    def test_pins_agree_here_and_a_drifted_one_is_caught(self):
        self.assertEqual(len(set(H.pins().values())), 1)
        with tempfile.TemporaryDirectory() as tmp:
            for f in H.PINS: shutil.copy(ROOT / f, Path(tmp) / f)
            ps1 = Path(tmp) / "demo.ps1"; text = ps1.read_text(encoding="utf-8")
            sha = H.pins()["demo.ps1"]; ps1.write_text(text.replace(sha, "0" * 40), encoding="utf-8")
            self.assertEqual(len(set(H.pins(tmp).values())), 2)


if __name__ == "__main__":
    unittest.main()
