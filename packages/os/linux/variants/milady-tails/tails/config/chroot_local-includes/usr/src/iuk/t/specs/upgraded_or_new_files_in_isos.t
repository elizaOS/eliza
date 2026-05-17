use Test::Spec;

use 5.10.1;
use Data::Dumper;
use File::Temp qw{tempdir tempfile};
use Path::Tiny;
use Tails::IUK;
use Test::Fatal qw{dies_ok};

my @genisoimage_opts = qw{--quiet -J -l -cache-inodes -allow-multidot};
my @genisoimage = ('genisoimage', @genisoimage_opts);

describe 'The upgraded_or_new_files_in_isos function' => sub {
    describe 'when run on a non-existing ISO' => sub {
        it 'throws an exception' => sub {
            dies_ok { Tails::IUK::upgraded_or_new_files_in_isos(
                path('non-existing1.iso'), path('non-existing2.iso'), 'dir', [ qr{.*}xms ]
            ) };
        };
    };
    describe 'when called with a directory that only exists in the old ISO' => sub {
        my $tempdir;
        before sub {
            $tempdir = tempdir(CLEANUP => 1);
            for my $generation (qw{old new}) {
                my $filename = path($tempdir, $generation.'.iso');
                my $iso_tempdir = tempdir(CLEANUP => 1);
                if ($generation eq 'old') {
                    path($iso_tempdir, 'old')->mkpath;
                    path($iso_tempdir, 'old', 'file')->touch;
                }
                system(@genisoimage, "-o", $filename, $iso_tempdir);
            }
        };
        it 'returns an empty list' => sub {
            is(
                scalar(Tails::IUK::upgraded_or_new_files_in_isos(
                    path($tempdir, 'old.iso'),
                    path($tempdir, 'new.iso'),
                    'old', [ qr{.*}xms ]
                )),
                0
            );
        };
    };
    describe 'when called with a directory that only exists in the new ISO' => sub {
        my $tempdir;
        before sub {
            $tempdir = tempdir(CLEANUP => 1);
            for my $generation (qw{old new}) {
                my $filename = path($tempdir, $generation.'.iso');
                my $iso_tempdir = tempdir(CLEANUP => 1);
                if ($generation eq 'new') {
                    path($iso_tempdir, 'new')->mkpath;
                    path($iso_tempdir, 'new', 'file')->touch;
                }
                system(@genisoimage, "-o", $filename, $iso_tempdir);
            }
        };
        it 'returns 1 element' => sub {
            is(
                scalar(Tails::IUK::upgraded_or_new_files_in_isos(
                    path($tempdir, 'old.iso'),
                    path($tempdir, 'new.iso'),
                    'new', [ qr{.*}xms ]
                )),
                1
            );
        };
    };
    describe 'when the new ISO has a file thas the old one has not' => sub {
        my $tempdir;
        before sub {
            $tempdir = tempdir(CLEANUP => 1);
            for my $generation (qw{old new}) {
                my $filename = path($tempdir, $generation.'.iso');
                my $iso_tempdir = tempdir(CLEANUP => 1);
                path($iso_tempdir, 'in_common')->touch;
                path($iso_tempdir, 'dir')->mkpath;
                path($iso_tempdir, 'dir', 'new')->touch if ($generation eq 'new');
                system(@genisoimage, "-o", $filename, $iso_tempdir);
            }
        };
        it 'returns 1 element' => sub {
            is(
                scalar(Tails::IUK::upgraded_or_new_files_in_isos(
                    path($tempdir, 'old.iso'),
                    path($tempdir, 'new.iso'),
                    'dir', [ qr{.*}xms ]
                )),
                1
            );
        };
    };
};

runtests unless caller;
