#!/usr/bin/env python
# encoding: utf-8
import json
from subprocess import Popen, PIPE


wrapper = u'''
(function run(globals) {
    try {
        var result = (%(func)s).apply(globals, %(args)s);
        if ((typeof result) == 'string') {
            result = JSON.stringify(result);
        }
        console.log(JSON.stringify({"result": result}))
    } catch (e) {
        console.log(JSON.stringify({error: e.message}));
    }
})(%(globals)s);
'''


def execute(code, args=None, g=None, node_exec='node'):
    if args is None:
        args = []

    if g is None:
        g = {}

    assert isinstance(code, str)
    assert isinstance(g, dict)
    assert code.strip(" ").strip("\t").startswith('function'), "Code must be function"

    prc = Popen(node_exec, shell=False, stderr=PIPE, stdout=PIPE, stdin=PIPE)

    c = wrapper % {
        'func': code,
        'globals': json.dumps(g),
        'args': json.dumps(args)
    }

    prc.stdin.write(c.encode('utf-8'))
    prc.stdin.close()
    prc.wait()

    result = json.loads(prc.stdout.read())

    if 'result' in result:
        result = result.get('result')
        if isinstance(result, str):
            result = json.dumps(result, ensure_ascii=False)
        return result
    else:
        raise Exception((
            result.get('error'),
            prc.stderr.read(),
        ))


if __name__ == '__main__':
    print(execute('''function test () {
        return 10;
    }'''))

    print(execute('''function (args) {
        var result = 0;

        args.map(function (i) {
            result += i;
        });
        return result;
    }''', args=[[1, 2, 3, 4, 5]]))

    print(execute('''function () {
        return 1.0/0;
    }'''))
