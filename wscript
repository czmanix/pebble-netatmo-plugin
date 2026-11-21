#
# Build rules for a Pebble plugin: a pbw holding only the plugin's script and its settings page,
# with nothing to install on the watch.
#
top = '.'
out = 'build'


def options(ctx):
    ctx.load('pebble_sdk')


def configure(ctx):
    ctx.load('pebble_sdk')


def build(ctx):
    ctx.load('pebble_sdk')
    ctx.pbl_bundle(binaries=[])
