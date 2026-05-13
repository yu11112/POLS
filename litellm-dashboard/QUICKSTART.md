# 快速上手（5 分钟）

## 第 1 步：准备 OpenAI API Key

1. 用**第一个** OpenAI 账号登录 <https://platform.openai.com/api-keys>
2. 点 **Create new secret key**，复制出来（只显示一次！），记作 `Key A`
3. **退出登录**，再用**第二个**账号登录，同样创建一个 Key，记作 `Key B`

> 注意：要的是 **API Key**（以 `sk-` 开头的那个），不是 ChatGPT Plus 订阅。
> API 额度需要去 <https://platform.openai.com/settings/organization/billing> 充值，
> 和 Plus 订阅是**两本账**。

## 第 2 步：安装 Docker

- **Windows / Mac**：下载 [Docker Desktop](https://www.docker.com/products/docker-desktop/)，装好启动即可。
- **Linux**：`curl -fsSL https://get.docker.com | sh`

验证：`docker --version` 有输出就 OK。

## 第 3 步：填 Key

```bash
cd litellm-dashboard
cp .env.example .env
```

然后用任意文本编辑器打开 `.env`，把三行替换成真实值：

```
OPENAI_API_KEY_1=sk-xxxxxxxxxxxxxxxxA      # 账号 A 的 Key
OPENAI_API_KEY_2=sk-xxxxxxxxxxxxxxxxB      # 账号 B 的 Key
LITELLM_MASTER_KEY=sk-my-random-string-123 # 随便写一个长字符串
```

（可选）编辑 `tracker/budgets.yaml` 改预算金额和账号名称：

```yaml
accounts:
  account-1:
    label: "老王的主号"
    monthly_budget_usd: 50
  account-2:
    label: "老王的小号"
    monthly_budget_usd: 30
```

## 第 4 步：启动

```bash
docker compose up -d
```

第一次会拉镜像，等 1-2 分钟。跑起来后访问：

- 🖥️ **面板**：<http://localhost:8080>
- 🔌 LiteLLM 接口：<http://localhost:4000>
- 📖 Tracker API 文档：<http://localhost:8000/docs>

## 第 5 步：测试一下

用 curl 发一次请求，看看面板有没有动：

```bash
curl http://localhost:4000/v1/chat/completions \
  -H "Authorization: Bearer sk-my-random-string-123" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
```

回到浏览器刷新面板，应该能看到账号卡片上出现了 1 次请求、几毫美元的消耗。

## 第 6 步：接入你的应用

**Python（OpenAI 官方 SDK）**：

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:4000",
    api_key="sk-my-random-string-123",   # 就是 .env 里的 LITELLM_MASTER_KEY
)

resp = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "你好"}],
)
print(resp.choices[0].message.content)
```

**Node.js**：

```js
import OpenAI from "openai";
const client = new OpenAI({
  baseURL: "http://localhost:4000",
  apiKey: "sk-my-random-string-123",
});
```

**其他应用**（只要兼容 OpenAI API）：把 `base_url` 指向 `http://localhost:4000`，`api_key` 填 `LITELLM_MASTER_KEY` 就行。

---

## 常用命令

```bash
docker compose logs -f litellm      # 看 LiteLLM 日志
docker compose logs -f tracker      # 看 Tracker 日志
docker compose restart              # 重启所有服务
docker compose down                 # 停止（保留数据）
docker compose down -v              # 停止并删除数据库
```

## 修改配置后如何生效

| 修改了什么                          | 怎么做                                   |
|-------------------------------------|------------------------------------------|
| `.env`（API Key、master key）       | `docker compose up -d`                   |
| `litellm/config.yaml`（加模型等）   | `docker compose restart litellm`         |
| `tracker/budgets.yaml`（改预算）    | `docker compose restart tracker` 或立即刷新页面 |
| `dashboard/public/*`（改前端）      | 刷新浏览器即可（已挂载）                 |

## 常见问题

**Q: 面板一直显示"还没有任何用量"？**
A: 说明还没有请求打到 LiteLLM，或者 callback 没收到。检查：
```bash
docker compose logs litellm | grep -i tracker
```

**Q: 为什么我看到的金额和 OpenAI 官网不完全一致？**
A: Tracker 用的是 LiteLLM 内置的模型单价表估算的，可能和实际账单有 ±5% 的差异。
官方真实数字请以 <https://platform.openai.com/usage> 为准。这个面板的目的是**实时**
感知和做预算告警，不是做财务对账。

**Q: 能加第三个账号吗？**
A: 可以。
1. `.env` 加 `OPENAI_API_KEY_3=sk-xxx`
2. `litellm/config.yaml` 每个 `model_name` 下再复制一组 deployment，`model_info.id` 写 `account-3`
3. `tracker/budgets.yaml` 加 `account-3:` 节点
4. `docker compose up -d`
