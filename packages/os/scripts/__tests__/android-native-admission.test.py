"""Offline native admission fixtures; no executable, APK build or device qualification."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import sys
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('native', Path(__file__).parents[1] / 'android/stage-android-native.py')
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)
sha = lambda value: hashlib.sha256(value).hexdigest()
encode = lambda value: json.dumps(value).encode()
ELF = b'\x7fELF\x02\x01' + bytes(12) + b'\xb7\x00' + bytes(44)


class NativeAdmission(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.apk = self.root / 'launcher.apk'
        self.output = self.root / 'output'
        self.output.mkdir()
        self.bp = '// Generated from a hash- and signer-verified downstream launcher.\nandroid_app_import {\n    name: "Eliza",\n    apk: "Launcher.apk",\n    presigned: true,\n    preprocessed: true,\n    product_specific: true,\n    dex_preopt: { enabled: false },\n}\n'
        (self.output / 'Android.bp').write_text(self.bp)

    def fixture(self, kind='aosp-build', target='linux-musl'):
        commit = '1' * 40
        modes = ['libeliza_bun.so'] if target == 'android' else list(native.RUNTIME_MODES)
        assets = ['bun'] if target == 'android' else list(native.TARGETS['stallion']['assets'].values()) + ['libstdc++.so.6.0.33']
        entries = {'AndroidManifest.xml': b'manifest fixture'}
        entries.update({'assets/agent/' + name: b'payload' for name in native.REQUIRED_AGENT_ASSETS})
        entries.update({'lib/arm64-v8a/' + name: ELF for name in modes})
        entries.update({'assets/agent/arm64-v8a/' + name: ELF for name in assets})
        pin = {'version': '1.4.2', 'revision': '2' * 40, 'artifacts': {'aarch64': {'binarySha256': sha(ELF)}}}
        records = [{'path': name, 'size_bytes': len(value), 'sha256': sha(value)} for name, value in entries.items() if name.startswith(('assets/agent/', 'lib/'))]
        provenance = {'schema': 'eliza.android_agent_runtime_provenance.v1', 'bun': {'version': pin['version'], 'revision': pin['revision'], 'channel': 'stable', 'target': target}, 'files': records}
        provenance_entry = 'assets/agent/android-agent-runtime-provenance.json'
        entries[provenance_entry] = encode(provenance)
        admission = {'schemaVersion': 1, 'bunTarget': target, 'bunPin': pin}
        if kind == 'aosp-build':
            source = {'kind': kind, 'entry': 'META-INF/eliza/aosp-build-provenance.json', 'commit': commit, 'package': 'ai.elizaos.app'}
            build = {'schema': 'eliza.aosp_build_provenance.v1', 'git_revision': commit, 'android_package': 'ai.elizaos.app', 'runtime_provenance_entry': provenance_entry, 'runtime_provenance_sha256': sha(entries[provenance_entry]), 'runtime_provenance': provenance, 'packaged_runtime_files': [{'path': name, 'size_bytes': len(value), 'sha256': sha(value)} for name, value in entries.items() if name.startswith(('assets/agent/', 'lib/'))]}
            entries[source['entry']] = encode(build)
        else:
            receipt = {'commit': commit, 'preparerSha256': '3' * 64}
            source = {'kind': 'exact-json', 'entry': 'assets/agent/runtime-source.json', 'commit': commit, 'expected': receipt}
            entries[source['entry']] = encode(receipt)
            entries['assets/agent/native-view-policy.json'] = b'{}'
            admission['fileBindings'] = {'assets/agent/native-view-policy.json': sha(b'{}')}
        admission['source'] = source
        return entries, admission

    def run_stage(self, entries, admission):
        with zipfile.ZipFile(self.apk, 'w', compression=zipfile.ZIP_STORED) as archive:
            for name, data in entries.items():
                archive.writestr(name, data)
        return native.stage(self.apk, self.output, 'Eliza', admission=admission)

    def test_both_source_contracts_stage_identical_native_bytes(self):
        for kind in ['aosp-build', 'exact-json']:
            with self.subTest(kind=kind):
                entries, admission = self.fixture(kind)
                output = self.output
                self.output = self.root / kind
                self.output.mkdir()
                (self.output / 'Android.bp').write_text(self.bp)
                result = self.run_stage(entries, admission)
                self.assertTrue(result['nativeLibrariesStaged'])
                self.assertEqual(result['moduleName'], 'Eliza')
                self.assertEqual(result['runtimeAdmission']['sourceCommit'], '1' * 40)
                self.assertFalse(result['runtimeVerified'])
                self.assertFalse(result['deployReady'])
                self.assertEqual((self.output / 'native-arm64/libeliza_bun.so').read_bytes(), ELF)
                self.output = output

    def test_native_android_bun_uses_the_same_admission_without_musl(self):
        entries, admission = self.fixture(target='android')
        result = self.run_stage(entries, admission)
        self.assertEqual([row['apkEntry'] for row in result['libraries']], ['lib/arm64-v8a/libeliza_bun.so'])
        self.assertNotIn('musl', (self.output / 'Android.mk').read_text())

    def test_soong_finalizer_preserves_companions_and_refuses_generated_name_collision(self):
        for companion in ['ElizaSense', 'Eliza_native_0']:
            with self.subTest(companion=companion):
                entries, admission = self.fixture(target='android')
                suffix = ('\nprebuilt_etc {\n    name: "ElizaDefaultPermissions",\n'
                          '    src: "default-permissions.xml",\n}\n'
                          '\nandroid_app_import {\n    name: "'+companion+'",\n'
                          '    apk: "'+companion+'.apk",\n    presigned: true,\n'
                          '    product_specific: true,\n    dex_preopt: { enabled: false },\n}\n')
                self.output = self.root / companion
                self.output.mkdir()
                (self.output / 'Android.bp').write_text(self.bp + suffix)
                admission.update(launcherBlueprint=self.bp + suffix, remainingBlueprint=suffix)
                report = self.run_stage(entries, admission)
                (self.output / 'Launcher.apk').write_bytes(self.apk.read_bytes())
                before = {str(path.relative_to(self.output)): path.read_bytes()
                          for path in self.output.rglob('*') if path.is_file()}
                if companion == 'Eliza_native_0':
                    with self.assertRaisesRegex(ValueError, 'native module name collides'):
                        native.finalize_soong(self.output, 'Eliza', report, suffix)
                    self.assertEqual({str(path.relative_to(self.output)): path.read_bytes()
                                      for path in self.output.rglob('*') if path.is_file()}, before)
                else:
                    result = native.finalize_soong(self.output, 'Eliza', report, suffix)
                    blueprint = (self.output / 'Android.bp').read_text()
                    self.assertIn('    required: ["Eliza_native_0"],', blueprint)
                    self.assertIn('prebuilt_app_native {\n    name: "Eliza_native_0",', blueprint)
                    self.assertTrue(blueprint.endswith(suffix))
                    self.assertEqual(blueprint.count('    required:'), 1)
                    self.assertFalse((self.output / 'Android.mk').exists())
                    self.assertEqual((self.output / 'Launcher.apk').read_bytes(), before['Launcher.apk'])
                    self.assertEqual((self.output / 'config.fs').read_bytes(), before['config.fs'])
                    self.assertEqual((self.output / 'native-arm64/libeliza_bun.so').read_bytes(), before['native-arm64/libeliza_bun.so'])
                    self.assertFalse(result['runtimeVerified'])
                    self.assertFalse(result['deployReady'])

    def test_unbound_source_package_and_final_file_closure_fail_before_write(self):
        original, admission = self.fixture()
        source_entry = admission['source']['entry']
        variants = []
        for field, value in [('git_revision', '4' * 40), ('android_package', 'foreign.package'), ('runtime_provenance_sha256', '0' * 64)]:
            entries = dict(original)
            receipt = json.loads(entries[source_entry])
            receipt[field] = value
            entries[source_entry] = encode(receipt)
            variants.append(entries)
        variants.append({**original, 'assets/agent/unbound.js': b'not bound'})
        variants.append({**original, 'assets/agent/agent-bundle.js': b'changed'})
        for entries in variants:
            with self.subTest(entries=list(entries)):
                with self.assertRaises(ValueError):
                    self.run_stage(entries, admission)
                self.assertEqual((self.output / 'Android.bp').read_text(), self.bp)
                self.assertEqual(len(list(self.output.iterdir())), 1)

    def rebind_build_receipt(self, entries, admission):
        entry = 'assets/agent/android-agent-runtime-provenance.json'
        provenance = json.loads(entries[entry])
        for row in provenance['files']:
            row.update(size_bytes=len(entries[row['path']]), sha256=sha(entries[row['path']]))
        entries[entry] = encode(provenance)
        receipt_entry = admission['source']['entry']
        receipt = json.loads(entries[receipt_entry])
        receipt.update(runtime_provenance_sha256=sha(entries[entry]), runtime_provenance=provenance)
        receipt['packaged_runtime_files'] = [{'path': name, 'size_bytes': len(data), 'sha256': sha(data)} for name, data in entries.items() if name.startswith(('assets/agent/', 'lib/'))]
        entries[receipt_entry] = encode(receipt)

    def test_self_consistent_empty_required_runtime_files_are_rejected(self):
        for name in native.REQUIRED_AGENT_ASSETS:
            entries, admission = self.fixture()
            entries['assets/agent/' + name] = b''
            self.rebind_build_receipt(entries, admission)
            with self.subTest(name=name):
                with self.assertRaisesRegex(ValueError, 'Required runtime payload must be nonempty'):
                    self.run_stage(entries, admission)
                self.assertEqual(len(list(self.output.iterdir())), 1)

    def test_nonessential_empty_files_remain_bound_to_the_build_receipt(self):
        entries, admission = self.fixture()
        name = 'assets/agent/optional.txt'
        entries[name] = b''
        entry = 'assets/agent/android-agent-runtime-provenance.json'
        provenance = json.loads(entries[entry])
        provenance['files'].append({'path': name, 'size_bytes': 0, 'sha256': sha(b'')})
        entries[entry] = encode(provenance)
        self.rebind_build_receipt(entries, admission)
        self.run_stage(entries, admission)

    def test_manifest_bounds_preserve_small_contracts_and_allow_bounded_full_build_receipts(self):
        entries, admission = self.fixture()
        receipt_entry = admission['source']['entry']
        receipt = json.loads(entries[receipt_entry])
        receipt['padding'] = 'x' * (1024 * 1024)
        entries[receipt_entry] = encode(receipt)
        with self.assertRaisesRegex(ValueError, 'Oversized runtime manifest'):
            self.run_stage(entries, admission)
        admission['source']['maxBytes'] = 16 * 1024 * 1024
        self.run_stage(entries, admission)

    def test_self_consistent_binary_substitution_cannot_override_the_pin(self):
        entries, admission = self.fixture()
        changed = ELF + b'replacement'
        for name in ['lib/arm64-v8a/libeliza_bun.so', 'assets/agent/arm64-v8a/bun']:
            entries[name] = changed
        entry = 'assets/agent/android-agent-runtime-provenance.json'
        provenance = json.loads(entries[entry])
        for row in provenance['files']:
            if row['path'] in ['lib/arm64-v8a/libeliza_bun.so', 'assets/agent/arm64-v8a/bun']:
                row.update(size_bytes=len(changed), sha256=sha(changed))
        entries[entry] = encode(provenance)
        with self.assertRaisesRegex(ValueError, 'pinned binary'):
            self.run_stage(entries, admission)
        self.assertEqual(len(list(self.output.iterdir())), 1)

    def test_resident_runtime_cannot_skip_external_admission_or_policy_binding(self):
        entries, admission = self.fixture('exact-json')
        with self.assertRaisesRegex(ValueError, 'admission contract'):
            self.run_stage(entries, None)
        entries['assets/agent/native-view-policy.json'] = b'changed'
        with self.assertRaisesRegex(ValueError, 'policy binding'):
            self.run_stage(entries, admission)
        self.assertEqual(len(list(self.output.iterdir())), 1)


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--fixture':
        output = Path(sys.argv[2])
        output.mkdir(parents=True)
        case = NativeAdmission()
        case.setUp()
        entries, admission = case.fixture()
        with zipfile.ZipFile(output / 'launcher.apk', 'w', compression=zipfile.ZIP_STORED) as archive:
            for name, data in entries.items():
                archive.writestr(name, data)
        (output / 'Android.bp').write_text(case.bp)
        (output / 'product.mk').write_text('PRODUCT_PACKAGES += Eliza\n')
        (output / 'admission.json').write_text(json.dumps(admission))
        case.temp.cleanup()
    else:
        unittest.main()
