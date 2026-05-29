use Test::Spec;

use Env qw{@PATH};
use FindBin;
unshift @PATH, "$FindBin::Bin/../../bin";

use lib qw{lib t/lib};

use 5.10.1;
use strictures 2;

BEGIN {
    plan skip_all => 'detected GitLab CI' if defined $ENV{GITLAB_CI};
}

use Function::Parameters;
use IPC::System::Simple qw{systemx};
use Path::Tiny;
use Tails::IUK::Read;
use Test::Fatal qw{dies_ok};
use Test::Util qw{make_iuk};

fun create_file($size) {
    my $included_file = Path::Tiny->tempfile;
    $included_file->spew("c" x $size);
    return $included_file;
}

describe 'A read IUK object' => sub {
    describe 'whose constructor is built with no arguments' => sub {
        it 'dies' => sub {
            dies_ok { Tails::IUK::Read->new() };
        };
    };
    describe 'has a "new_from_file" method that' => sub {
        describe 'if called on an IUK file that is not a SquashFS image' => sub {
            my $iuk_filename;
            before sub {
                $iuk_filename = Path::Tiny->tempfile;
                $iuk_filename->touch;
            };
            it 'should die' => sub {
                dies_ok { Tails::IUK::Read->new_from_file($iuk_filename) };
            };
        };
    };
    describe 'has a "contains_file" method that' => sub {
        describe 'if the object is built from a valid IUK file that contains a whatever.file file' => sub {
            my $iuk;
            before sub {
                my $tempdir = Path::Tiny->tempdir;
                my $iuk_filename = Path::Tiny->tempfile;
                $tempdir->child('FORMAT')->spew("2");
                $tempdir->child('whatever.file')->touch;
                systemx('gensquashfs', '--quiet', '--force', '--pack-dir', $tempdir, $iuk_filename);
                $iuk = Tails::IUK::Read->new_from_file($iuk_filename);
            };
            it 'should return true when called on "whatever.file"' => $ENV{SKIP_SUDO} ? () : sub {
                ok($iuk->contains_file(path("whatever.file")));
            };
        };
        describe 'if the object is built from a valid IUK file that contains no whatever.file file' => sub {
            my $iuk;
            before sub {
                my $tempdir = Path::Tiny->tempdir;
                my $iuk_filename = Path::Tiny->tempfile;
                $tempdir->child('FORMAT')->spew("2");
                systemx('gensquashfs', '--quiet', '--force', '--pack-dir', $tempdir, $iuk_filename);
                $iuk = Tails::IUK::Read->new_from_file($iuk_filename);
            };
            it 'should return false when called on "whatever.file"' => $ENV{SKIP_SUDO} ? () : sub {
                ok(! $iuk->contains_file(path("whatever.file")));
            };
        };
    };
    describe 'has a "delete_files" method that' => sub {
        describe 'if the object is built from a valid IUK whose delete_files is empty' => sub {
            my $iuk;
            before sub {
                my $tempdir = Path::Tiny->tempdir;
                my $iuk_filename = Path::Tiny->tempfile;
                $tempdir->child('FORMAT')->spew("2");
                $tempdir->child('control.yml')->spew("delete_files:\n");
                systemx('gensquashfs', '--quiet', '--force', '--pack-dir', $tempdir, $iuk_filename);
                $iuk = Tails::IUK::Read->new_from_file($iuk_filename);
            };
            it 'should return an empty list' => $ENV{SKIP_SUDO} ? () : sub {
                is(@{$iuk->delete_files}, 0);
            };
        };
        describe 'if the object is built from a valid IUK whose delete_files contains whatever.file' => sub {
            my $iuk;
            before sub {
                my $tempdir = Path::Tiny->tempdir;
                my $iuk_filename = Path::Tiny->tempfile;
                $tempdir->child('FORMAT')->spew("2");
                $tempdir->child('control.yml')->spew(
                    "delete_files:\n  - file1\n  - file2\n  - whatever.file\n  - file4\n"
                );
                systemx('gensquashfs', '--quiet', '--force', '--pack-dir', $tempdir, $iuk_filename);
                $iuk = Tails::IUK::Read->new_from_file($iuk_filename);
            };
            it 'should return a list that contains whatever.file' => $ENV{SKIP_SUDO} ? () : sub {
                is(scalar(grep {$_ eq 'whatever.file'} @{$iuk->delete_files}), 1);
            };
        };
    };
    describe 'has a space_needed method that' => sub {
        describe 'if called on an IUK that contains no overlay directory' => sub {
            my $iuk;
            before sub {
                make_iuk(my $iuk_filename = Path::Tiny->tempfile);
                $iuk = Tails::IUK::Read->new_from_file($iuk_filename);
            };
            it 'should return ~ 0' => $ENV{SKIP_SUDO} ? () : sub {
                cmp_ok($iuk->space_needed, '>=', 0);
                cmp_ok($iuk->space_needed, '<=', 10);
            };
        };
        describe 'if called on an IUK whose overlay directory contains two 1MB files' => sub {
            my $iuk;
            before sub {
                make_iuk(
                    my $iuk_filename = Path::Tiny->tempfile,
                    overlay_filenames => [ 'whatever1.file', 'whatever2.file' ],
                    overlay_files_size => 1,
                );
                $iuk = Tails::IUK::Read->new_from_file($iuk_filename);
            };
            it 'should return ~ 2 * 2**10' => $ENV{SKIP_SUDO} ? () : sub {
                my $expected_size = 2 * 2**20;
                cmp_ok($iuk->space_needed, '>=', $expected_size);
                cmp_ok($iuk->space_needed, '<=', $expected_size * 1.1);
            };
        };
    };
};

runtests unless caller;
