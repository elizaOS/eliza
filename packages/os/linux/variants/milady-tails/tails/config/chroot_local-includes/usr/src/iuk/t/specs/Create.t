use Test::Spec;

use 5.10.1;
use strictures 2;
use Data::Dumper;
use File::Temp qw{tempdir tempfile};
use Path::Tiny;
use Tails::IUK;
use Test::Fatal qw{dies_ok};

BEGIN {
    plan skip_all => 'detected GitLab CI' if defined $ENV{GITLAB_CI};
}

my @genisoimage_opts = qw{--quiet -J -l -cache-inodes -allow-multidot};
my @genisoimage = ('genisoimage', @genisoimage_opts);

describe 'An IUK object' => sub {
    describe 'built with no arguments' => sub {
        it 'dies' => sub {
            dies_ok { Tails::IUK->new() };
        };
    };
    describe 'built with fake arguments' => sub {
        it 'dies' => sub {
            dies_ok { Tails::IUK->new(
                old_iso => path('old.iso'),
                new_iso => path('new.iso'),
                squashfs_diff_name => 'test.squashfs',
            )};
        };
    };
    describe 'built with real old_iso and new_iso arguments' => sub {
        my $iuk;
        before sub {
            my $tempdir = tempdir(CLEANUP => 1);

            my $old_iso = path($tempdir, 'old.iso');
            my $old_iso_tempdir = tempdir(CLEANUP => 1);
            path($old_iso_tempdir, 'isolinux')->mkpath;
            path($old_iso_tempdir, 'isolinux', 'isolinux.cfg')->touch;
            my $old_squashfs_tempdir = tempdir(CLEANUP => 1);
            # an empty SquashFS is invalid
            path($old_squashfs_tempdir, '.placeholder')->touch;
            path($old_iso_tempdir, 'live')->mkpath;
            `gensquashfs --quiet --pack-dir $old_squashfs_tempdir $old_iso_tempdir/live/filesystem.squashfs 2>/dev/null`;
            system(@genisoimage, "-o", $old_iso, $old_iso_tempdir);

            my $new_iso = path($tempdir, 'new.iso');
            my $new_iso_tempdir = tempdir(CLEANUP => 1);
            path($new_iso_tempdir, 'isolinux')->mkpath;
            path($new_iso_tempdir, 'isolinux', 'isolinux.cfg')->touch;
            my $new_squashfs_tempdir = tempdir(CLEANUP => 1);
            # an empty SquashFS is invalid
            path($new_squashfs_tempdir, '.placeholder')->touch;
            path($new_iso_tempdir, 'EFI')->mkpath;
            path($new_iso_tempdir, 'utils')->mkpath;
            path($new_iso_tempdir, 'live')->mkpath;
            `gensquashfs --quiet --pack-dir $new_squashfs_tempdir $new_iso_tempdir/live/filesystem.squashfs 2>/dev/null`;
            system(@genisoimage, "-o", $new_iso, $new_iso_tempdir);

            $iuk = Tails::IUK->new(
                old_iso => $old_iso,
                new_iso => $new_iso,
                squashfs_diff_name => 'test.squashfs',
            );
        };
        it 'can be written out' => $ENV{SKIP_SUDO} ? () : sub {
            # XXX:
            my ($out_fh, $out_filename) = tempfile();
            unlink($out_filename);
            $iuk->saveas($out_filename);
            ok(-e $out_filename);
        };
        it 'has an empty delete_files list' => sub {
            is(@{$iuk->delete_files}, 0);
        };
    };
    describe 'has a delete_files method that' => sub {
        describe 'if the object is built from an old ISO that contains file live/a and a new ISO that does not' => sub {
            my $iuk;
            before sub {
                my $tempdir = tempdir(CLEANUP => 1);

                my $old_iso = path($tempdir, 'old.iso');
                my $old_iso_tempdir = tempdir(CLEANUP => 1);
                path($old_iso_tempdir, 'live')->mkpath;
                path($old_iso_tempdir, 'live/a')->touch;
                system(@genisoimage, "-o", $old_iso, $old_iso_tempdir);

                my $new_iso = path($tempdir, 'new.iso');
                my $new_iso_tempdir = tempdir(CLEANUP => 1);
                system(@genisoimage, "-o", $new_iso, $new_iso_tempdir);

                $iuk = Tails::IUK->new(
                    old_iso => $old_iso,
                    new_iso => $new_iso,
                    squashfs_diff_name => 'test.squashfs',
                );
            };
            it 'returns a list that contains live/a' => sub {
                is(scalar(grep { $_ eq 'live/a' } @{$iuk->delete_files}), 1);
            };
        };
    };
    describe 'has a new_kernels method that' => sub {
        describe 'if the object is built from two identical ISOs' => sub {
            my $iuk;
            before sub {
                my $tempdir = tempdir(CLEANUP => 1);

                my $old_iso = path($tempdir, 'old.iso');
                my $old_iso_tempdir = tempdir(CLEANUP => 1);
                system(@genisoimage, "-o", $old_iso, $old_iso_tempdir);

                my $new_iso = path($tempdir, 'new.iso');
                my $new_iso_tempdir = tempdir(CLEANUP => 1);
                system(@genisoimage, "-o", $new_iso, $new_iso_tempdir);

                $iuk = Tails::IUK->new(
                    old_iso => $old_iso,
                    new_iso => $new_iso,
                    squashfs_diff_name => 'test.squashfs',
                );
            };
            it 'returns an empty list' => sub {
                is(scalar(@{$iuk->new_kernels}), 0);
            };
        };
        describe 'if the object is built from ISOs that do not contain the same set of kernels' => sub {
            my $iuk;
            before sub {
                my $tempdir = tempdir(CLEANUP => 1);

                my $old_iso = path($tempdir, 'old.iso');
                my $old_iso_tempdir = tempdir(CLEANUP => 1);
                path($old_iso_tempdir, 'live')->mkpath;
                path($old_iso_tempdir, 'live', 'vmlinuz')->spew("bla1");
                system(@genisoimage, "-o", $old_iso, $old_iso_tempdir);

                my $new_iso = path($tempdir, 'new.iso');
                my $new_iso_tempdir = tempdir(CLEANUP => 1);
                path($new_iso_tempdir, 'live')->mkpath;
                path($new_iso_tempdir, 'live', 'vmlinuz')->spew("bla2");
                system(@genisoimage, "-o", $new_iso, $new_iso_tempdir);

                $iuk = Tails::IUK->new(
                    old_iso => $old_iso,
                    new_iso => $new_iso,
                    squashfs_diff_name => 'test.squashfs',
                );
            };
            it 'returns a non-empty list' => sub {
                my $new_kernels = $iuk->new_kernels;
                ok(scalar(@{$new_kernels}) >= 1);
            };
        };
    };
};

runtests unless caller;
