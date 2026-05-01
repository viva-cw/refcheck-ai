"""
RefCheck AI — Unit Tests for frame_analyzer.py
===============================================
Run with:   python test_frame_analyzer.py
or:         python -m pytest test_frame_analyzer.py -v
"""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

# Allow importing from the same directory
sys.path.insert(0, str(Path(__file__).parent))

from frame_analyzer import (
    SPORT_RULES,
    _SPORT_ALIASES,
    build_system_instruction,
    build_user_prompt,
    extract_frames,
    resolve_sport,
)


class TestResolveSport(unittest.TestCase):
    def test_canonical_keys_pass_through(self):
        for sport in SPORT_RULES:
            self.assertEqual(resolve_sport(sport), sport)

    def test_aliases_resolve(self):
        self.assertEqual(resolve_sport("nba"), "basketball")
        self.assertEqual(resolve_sport("nfl"), "americanfootball")
        self.assertEqual(resolve_sport("mlb"), "baseball")
        self.assertEqual(resolve_sport("nhl"), "hockey")

    def test_case_insensitive(self):
        self.assertEqual(resolve_sport("NBA"), "basketball")
        self.assertEqual(resolve_sport("Soccer"), "soccer")
        self.assertEqual(resolve_sport("HOCKEY"), "hockey")

    def test_unknown_sport_returns_itself(self):
        self.assertEqual(resolve_sport("cricket"), "cricket")


class TestBuildSystemInstruction(unittest.TestCase):
    def test_contains_sport_name(self):
        instruction = build_system_instruction("basketball")
        self.assertIn("BASKETBALL", instruction)

    def test_contains_rules(self):
        instruction = build_system_instruction("basketball")
        self.assertIn("Blocking vs Charging", instruction)
        self.assertIn("Verticality", instruction)

    def test_contains_json_schema(self):
        instruction = build_system_instruction("soccer")
        self.assertIn('"verdict"', instruction)
        self.assertIn('"confidence"', instruction)
        self.assertIn('"reasoning"', instruction)

    def test_alias_resolves_in_instruction(self):
        instruction = build_system_instruction("nba")
        # alias 'nba' resolves to 'basketball', so the instruction should show BASKETBALL
        self.assertIn("BASKETBALL", instruction)

    def test_unknown_sport_uses_fallback(self):
        instruction = build_system_instruction("cricket")
        self.assertIn("CRICKET", instruction)
        self.assertIn("standard official rules", instruction)

    def test_all_sports_have_rules(self):
        for sport in SPORT_RULES:
            instruction = build_system_instruction(sport)
            self.assertIn(sport.upper(), instruction)


class TestBuildUserPrompt(unittest.TestCase):
    def test_with_original_call(self):
        prompt = build_user_prompt(10, "Blocking foul on #23")
        self.assertIn("Blocking foul on #23", prompt)
        self.assertIn("10 frames", prompt)

    def test_without_original_call(self):
        prompt = build_user_prompt(8, None)
        self.assertIn("No original call", prompt)
        self.assertIn("8 frames", prompt)

    def test_empty_call_treated_as_none(self):
        prompt = build_user_prompt(5, "   ")
        self.assertIn("No original call", prompt)


class TestExtractFrames(unittest.TestCase):
    """
    Tests for extract_frames() using a synthetic video created with OpenCV.
    Falls back gracefully if OpenCV cannot write video on the current platform.
    """

    def _make_test_video(self, path: str, num_frames: int = 60, fps: float = 30.0):
        """Create a minimal valid MP4 with solid-color frames."""
        import cv2
        import numpy as np

        fourcc = cv2.VideoWriter_fourcc(*"mp4v")
        out = cv2.VideoWriter(path, fourcc, fps, (160, 120))
        if not out.isOpened():
            return False
        for i in range(num_frames):
            # Gradient color so frames are visually distinct
            color = (int(255 * i / num_frames), 100, 200)
            frame = np.full((120, 160, 3), color, dtype="uint8")
            out.write(frame)
        out.release()
        return True

    def test_nonexistent_file_raises(self):
        with self.assertRaises(FileNotFoundError):
            extract_frames("/does/not/exist.mp4")

    def test_extracts_correct_count(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            video_path = os.path.join(tmpdir, "test.mp4")
            if not self._make_test_video(video_path, num_frames=90):
                self.skipTest("OpenCV VideoWriter not available on this platform.")

            frames = extract_frames(video_path, num_frames=10)
            self.assertEqual(len(frames), 10)

    def test_frame_structure(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            video_path = os.path.join(tmpdir, "test.mp4")
            if not self._make_test_video(video_path, num_frames=60):
                self.skipTest("OpenCV VideoWriter not available on this platform.")

            frames = extract_frames(video_path, num_frames=5)
            for i, frame in enumerate(frames):
                with self.subTest(frame_index=i):
                    self.assertIn("index", frame)
                    self.assertIn("frame_number", frame)
                    self.assertIn("timestamp_s", frame)
                    self.assertIn("timestamp_str", frame)
                    self.assertIn("image_bytes", frame)
                    self.assertIsInstance(frame["image_bytes"], bytes)
                    self.assertGreater(len(frame["image_bytes"]), 0)

    def test_frames_are_ordered(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            video_path = os.path.join(tmpdir, "test.mp4")
            if not self._make_test_video(video_path, num_frames=60):
                self.skipTest("OpenCV VideoWriter not available on this platform.")

            frames = extract_frames(video_path, num_frames=6)
            timestamps = [f["timestamp_s"] for f in frames]
            self.assertEqual(timestamps, sorted(timestamps))

    def test_frames_saved_to_disk(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            video_path = os.path.join(tmpdir, "test.mp4")
            if not self._make_test_video(video_path, num_frames=60):
                self.skipTest("OpenCV VideoWriter not available on this platform.")

            frames_dir = os.path.join(tmpdir, "frames")
            frames = extract_frames(video_path, num_frames=5, output_dir=frames_dir)
            saved = list(Path(frames_dir).glob("*.jpg"))
            self.assertEqual(len(saved), len(frames))
            for frame in frames:
                self.assertIsNotNone(frame["file_path"])
                self.assertTrue(Path(frame["file_path"]).exists())

    def test_fewer_frames_than_requested(self):
        """Requesting more frames than the video has should not crash."""
        with tempfile.TemporaryDirectory() as tmpdir:
            video_path = os.path.join(tmpdir, "test.mp4")
            if not self._make_test_video(video_path, num_frames=5):
                self.skipTest("OpenCV VideoWriter not available on this platform.")

            frames = extract_frames(video_path, num_frames=20)
            self.assertLessEqual(len(frames), 5)


class TestAnalyzePlayIntegration(unittest.TestCase):
    """
    Integration-style tests for analyze_play() using mocked Gemini calls.
    These tests verify the pipeline logic without requiring a real API key.
    """

    MOCK_RESPONSE = json.dumps({
        "verdict": "Bad Call",
        "confidence": "High",
        "play_description": "Defender's feet are still moving at point of contact.",
        "reasoning": "Per NBA Rule 12B, the defender had not established legal guarding position.",
        "relevant_rule": "NBA Rule 12B — Blocking vs Charging",
        "key_frames": [3, 5, 7],
    })

    def _make_test_video(self, path: str):
        import cv2
        import numpy as np
        fourcc = cv2.VideoWriter_fourcc(*"mp4v")
        out = cv2.VideoWriter(path, fourcc, 30.0, (160, 120))
        if not out.isOpened():
            return False
        for _ in range(60):
            out.write(np.zeros((120, 160, 3), dtype="uint8"))
        out.release()
        return True

    @patch("frame_analyzer.genai.Client")
    @patch.dict(os.environ, {"GEMINI_API_KEY": "test-key-abc"})
    def test_analyze_play_returns_correct_fields(self, mock_client_cls):
        mock_response = MagicMock()
        mock_response.text = self.MOCK_RESPONSE
        mock_client_instance = MagicMock()
        mock_client_instance.models.generate_content.return_value = mock_response
        mock_client_cls.return_value = mock_client_instance

        with tempfile.TemporaryDirectory() as tmpdir:
            video_path = os.path.join(tmpdir, "clip.mp4")
            if not self._make_test_video(video_path):
                self.skipTest("OpenCV VideoWriter not available.")

            from frame_analyzer import analyze_play
            result = analyze_play(video_path, sport="basketball", num_frames=5)

        self.assertEqual(result["verdict"], "Bad Call")
        self.assertEqual(result["confidence"], "High")
        self.assertIn("play_description", result)
        self.assertIn("reasoning", result)
        self.assertIn("relevant_rule", result)
        self.assertIn("metadata", result)
        self.assertEqual(result["metadata"]["sport"], "basketball")

    @patch.dict(os.environ, {}, clear=True)
    def test_missing_api_key_raises(self):
        from frame_analyzer import analyze_play
        with self.assertRaises(EnvironmentError):
            analyze_play("fake.mp4", sport="soccer")


if __name__ == "__main__":
    unittest.main(verbosity=2)
